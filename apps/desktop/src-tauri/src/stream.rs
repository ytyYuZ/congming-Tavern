//! The dumb byte pipe: one HTTP request in, the provider's bytes out.
//!
//! WHAT THIS FILE MUST NEVER DO (docs/02-技术架构.md §6 and the M0-T8 contract):
//! parse SSE, redact, classify vendor errors, read the status code to decide
//! whether to surface the body, or translate the body at all. Vendor semantics
//! live in JavaScript, where `packages/providers/src/llm/openai-compatible.ts`
//! already has tests for them; a second implementation on this side would be a
//! second source of truth for the four error mappings. So the body of a 401 and
//! the body of a 200 take the same road: `response` event, `chunk` events, `end`.
//!
//! WHAT IT DOES DO: open the connection with rustls, forward the caller's method,
//! headers and body verbatim, hand each `Response::chunk()` over as raw bytes
//! (base64 in the event, see `base64.rs` for why), and make cancellation real —
//! `llm_cancel` must stop the upstream request, because an LLM that keeps
//! generating after the user stopped costs the user money.
//!
//! TIMEOUTS. `timeout_ms` is the caller's whole-request budget: it covers
//! connecting, waiting for headers and reading the body. When it is absent the
//! client's own 5-minute ceiling applies, which is a backstop rather than a
//! policy.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tokio::sync::watch;

use crate::base64;
use crate::error::TransportError;
use crate::url_rules;

/// Where events go.
///
/// Abstracted over rather than spelled `Channel` everywhere for one reason: the
/// end-to-end tests need to drive the real `run` loop against a local HTTP server
/// and read its output back, and a `tauri::ipc::Channel` cannot exist outside a
/// running app. A trait object would do, but a generic keeps the hot path
/// monomorphised and inlinable. The only error either side can produce is "the
/// consumer is gone", which is a `String` because that is what a Tauri command
/// returns.
pub trait EventSink {
    fn send(&self, event: LlmStreamEvent) -> Result<(), String>;
}

impl EventSink for Channel<LlmStreamEvent> {
    fn send(&self, event: LlmStreamEvent) -> Result<(), String> {
        Channel::send(self, event).map_err(|error| format!("the UI channel is gone: {error}"))
    }
}

/// The caller's request, exactly as it crosses the IPC boundary (`camelCase`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmStreamRequest {
    /// Caller-chosen id, also the key `llm_cancel` uses to find this stream.
    pub request_id: String,
    pub url: String,
    pub method: String,
    /// Ordered, duplicated names preserved: a caller may legitimately send two of
    /// the same header, and a `HashMap` would silently drop one.
    pub headers: Vec<(String, String)>,
    pub body: String,
    /// Whole-request budget. `None` means "only the client backstop applies".
    pub timeout_ms: Option<u64>,
}

/// Every message this side can put on the channel, discriminated by `type`.
///
/// The variants are serialised by serde with the tag first, which is what the
/// TypeScript transport switches on. `Chunk` is the only one that carries payload
/// and it carries bytes, never a decoded string.
///
/// `Deserialize` is derived for one reason: the cross-language fixture test asserts
/// that every event in `src/transport/fixtures/llm-stream-events.json` round-trips
/// back to that exact JSON. Comparing rendered output alone would let two symmetric
/// renames on the other side pass unnoticed.
///
/// `rename_all_fields` is not redundant with `rename_all`: on an enum the latter
/// renames the VARIANTS, while the fields *inside* a variant keep their Rust names
/// unless `rename_all_fields` is also given — which is how `data_base64` would
/// silently ship as `data_base64` while the tag said `chunk`. This is exactly the
/// drift the fixture test caught.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LlmStreamEvent {
    /// The response head. Status and headers only: a non-2xx status is NOT a
    /// transport failure, because only JavaScript knows what it means.
    Response {
        status: u16,
        headers: Vec<(String, String)>,
    },
    /// A slice of the raw response body, base64-encoded.
    Chunk { data_base64: String },
    /// The body ended cleanly.
    End,
    /// The transport gave up. `kind` is the only classification this side makes.
    Error(TransportError),
}

/// Handle used by `llm_cancel` to reach a running stream.
///
/// A `watch::Sender<bool>` rather than a plain flag: the stream `select!`s on the
/// receiver, so cancellation interrupts an in-flight `chunk().await` immediately
/// instead of waiting for the next chunk to arrive. Dropping the connection (the
/// future is dropped) is what actually stops the upstream generation; the
/// receiver exists to make that happen now rather than later.
pub type CancelSlot = watch::Sender<bool>;

/// Own everything a stream needs, so the command body stays readable.
pub struct StreamContext<'a, S: EventSink> {
    pub request: &'a LlmStreamRequest,
    pub client: &'a reqwest::Client,
    pub cancel: watch::Receiver<bool>,
    /// Where the events go: the webview's channel in the app, a test sink in tests.
    pub events: &'a S,
}

/// Run one request to completion, reporting everything through `events`.
///
/// Returns `Ok(())` even when the request failed: every failure is an `error`
/// event, and the command's `Result` is reserved for the transport being unable to
/// *report* anything (a dead webview channel). That keeps a single failure path
/// for JavaScript to handle.
pub async fn run<S: EventSink>(context: StreamContext<'_, S>) -> Result<(), String> {
    let StreamContext {
        request,
        client,
        cancel,
        events,
    } = context;

    if let Err(reason) = url_rules::validate(&request.url) {
        return emit(
            events,
            LlmStreamEvent::Error(TransportError::refused(reason)),
        );
    }

    let method = match reqwest::Method::from_bytes(request.method.as_bytes()) {
        Ok(method) => method,
        Err(_) => {
            return emit(
                events,
                LlmStreamEvent::Error(TransportError::refused(format!(
                    "unusable HTTP method `{}`",
                    request.method
                ))),
            );
        }
    };

    let mut builder = client
        .request(method, &request.url)
        .body(request.body.clone());
    for (name, value) in &request.headers {
        builder = builder.header(name.as_str(), value.as_str());
    }

    // The `cancel` receiver is MOVED into `send_and_read`, which is what lets that
    // function own the single `select!` that races the upstream chunk against the
    // cancellation. An outer `select!` here would have to borrow the same receiver
    // mutably at the same time, and the body pump cannot run without it.
    let outcome = match request.timeout_ms.map(Duration::from_millis) {
        Some(budget) => {
            match tokio::time::timeout(budget, send_and_read(builder, &request.url, events, cancel))
                .await
            {
                Ok(outcome) => outcome,
                Err(_elapsed) => Err(TransportError::new(
                    crate::error::TransportErrorKind::Timeout,
                    "the provider did not answer within the timeout",
                )),
            }
        }
        None => send_and_read(builder, &request.url, events, cancel).await,
    };

    match outcome {
        Ok(()) => emit(events, LlmStreamEvent::End),
        Err(error) => emit(events, LlmStreamEvent::Error(error)),
    }
}

/// Send the request and pump the body until it ends or the caller cancels.
///
/// Owns the builder (because `RequestBuilder::send` takes `self`) and the cancel
/// receiver (because awaiting it needs `&mut`). The caller supplies the deadline by
/// wrapping this future in a `tokio::time::timeout`.
async fn send_and_read<S: EventSink>(
    builder: reqwest::RequestBuilder,
    url: &str,
    events: &S,
    mut cancel: watch::Receiver<bool>,
) -> Result<(), TransportError> {
    let sent = builder.send().await;
    let mut response = match sent {
        Ok(response) => response,
        Err(error) => {
            return Err(TransportError::from_reqwest("request failed", url, &error));
        }
    };

    let head = LlmStreamEvent::Response {
        status: response.status().as_u16(),
        headers: header_pairs(response.headers()),
    };
    // The head is emitted for EVERY status, 401 and 429 included: the caller has to
    // see what the provider said so its own classifier can label it.
    events.send(head).map_err(TransportError::refused)?;

    loop {
        // Biased, so a cancellation that arrives while a chunk is already buffered
        // still wins: a user who pressed stop expects the next thing they see to be
        // the stop, not one more token.
        tokio::select! {
            biased;
            _ = cancel.changed() => return Err(TransportError::cancelled()),
            next = response.chunk() => match next {
                Ok(Some(bytes)) => {
                    let event = LlmStreamEvent::Chunk {
                        data_base64: base64::encode(&bytes),
                    };
                    events.send(event).map_err(TransportError::refused)?;
                }
                Ok(None) => return Ok(()),
                Err(error) => {
                    return Err(TransportError::from_reqwest("stream failed", url, &error));
                }
            },
        }
    }
}

/// Put one event on the channel. A closed channel means the webview is gone, and
/// the caller of the command will see the error.
///
/// `event` is taken by value and the failure path is the only place it is needed,
/// so a sink that copies on send keeps its own clone (the Tauri channel does).
fn emit<S: EventSink>(events: &S, event: LlmStreamEvent) -> Result<(), String> {
    events.send(event).map_err(|error| {
        // Logged without the request: a log line is one of the places a key must
        // never reach (HANDOFF §4.1 invariant 6).
        eprintln!("[smarttavern] dropping a stream event: {error}");
        error
    })
}

/// Response headers as ordered pairs, with undecodable bytes made visible rather
/// than fatal: a provider that sends a stray high byte in a header must not break
/// a stream that is otherwise fine.
fn header_pairs(headers: &reqwest::header::HeaderMap) -> Vec<(String, String)> {
    headers
        .iter()
        .map(|(name, value)| {
            (
                name.as_str().to_string(),
                String::from_utf8_lossy(value.as_bytes()).into_owned(),
            )
        })
        .collect()
}
