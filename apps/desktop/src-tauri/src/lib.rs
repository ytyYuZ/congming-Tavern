//! SmartTavern desktop shell — the Tauri 2 half of M0-T8.
//!
//! WHAT THIS CRATE IS FOR (docs/02-技术架构.md §3, ADR-002): a thin native shell
//! that loads the apps/web UI and adds exactly two capabilities the browser
//! cannot have — an HTTP client that is not subject to CORS, and (later) system
//! keyring and filesystem access. It is deliberately not a second UI: the shell
//! builds the web app's `dist/` and shows it.
//!
//! THE ONE FEATURE SO FAR is the LLM transport (`llm_stream` / `llm_cancel`),
//! because HANDOFF §9 item 9 is explicit that a browser cannot be assumed to reach
//! every provider directly. The contract is a byte pipe: Rust forwards the request
//! and hands back the response bytes, and every vendor-specific decision — what a
//! 401 means, whether a 429 is worth retrying, how an SSE frame is parsed — stays
//! in the JavaScript that already has tests for it. See `stream.rs`.
//!
//! KEYS (HANDOFF §4.1 invariant 6). The `Authorization` header passes through this
//! crate as an opaque header value: it is never logged, never put in an event and
//! never put in an error message. `error.rs` is where that is enforced for the one
//! path that renders transport text.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// MSVC prints "creating library …dll.lib and object …dll.exp" to stdout on every
// cdylib link, and rustc's `linker_messages` lint reports that banner as a warning.
// It is the linker being chatty, not a diagnostic about this crate — and it would
// otherwise make `cargo clippy -- -D warnings` (the gate `tauri:check` runs AND the
// bar this repo holds every other toolchain to) fail on a clean build.
#![allow(linker_messages)]

pub mod base64;
pub mod error;
pub mod stream;
pub mod url_rules;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use tauri::Manager;
use tauri::State;

use stream::{CancelSlot, LlmStreamEvent, LlmStreamRequest, StreamContext};

/// Longest a single request may last when the caller sets no budget. Deliberately
/// generous: a reasoning model can legitimately think for minutes, and this is a
/// backstop against a hung socket, not a policy.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(300);

/// The cancellation handles of the streams currently in flight, keyed by the
/// caller's `request_id`.
///
/// A newtype around the map rather than a bare `Mutex<HashMap<…>>` because Tauri's
/// managed state has to be `Send + Sync + 'static` *and* addressable from the
/// spawned task by type; `Arc` is what makes the task able to own its handle after
/// the command has returned.
#[derive(Default)]
pub struct StreamHandles(Mutex<HashMap<String, CancelSlot>>);

impl StreamHandles {
    /// Take the map for the duration of one operation.
    ///
    /// Poisoning (a panic while holding the lock) is *recoverable* here and is
    /// recovered: the map holds no invariant a panic could have half-updated — at
    /// worst one stream's cancel handle is missing, which degrades to "that one
    /// request cannot be cancelled". Refusing every future request because an
    /// unrelated one panicked would be strictly worse.
    fn entries(&self) -> MutexGuard<'_, HashMap<String, CancelSlot>> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// Shared shell state: one HTTP client — so connections are pooled across turns and
/// the rustls configuration is built once — plus the in-flight streams.
pub struct AppState {
    client: reqwest::Client,
    streams: Arc<StreamHandles>,
}

impl AppState {
    /// Build the state around a client. The client is a parameter (rather than
    /// built here) so a test can inject one.
    pub fn new(client: reqwest::Client) -> Self {
        Self {
            client,
            streams: Arc::new(StreamHandles::default()),
        }
    }

    /// The client every request goes through.
    pub fn client(&self) -> &reqwest::Client {
        &self.client
    }
}

/// An HTTP client for talking to providers.
///
/// rustls, NOT the platform TLS stack (docs/06-开发任务拆解.md §9.4): one TLS
/// implementation everywhere means the transport behaves the same on every
/// platform, and it is the only stack that works on the machine this was built on
/// (Windows schannel is broken there, which is also why a local crates mirror
/// exists). Redirects are capped below reqwest's default so a provider that
/// answers 302 forever fails fast instead of looping.
pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .use_rustls_tls()
        .redirect(reqwest::redirect::Policy::limited(5))
        .timeout(DEFAULT_TIMEOUT)
        .build()
        .unwrap_or_else(|error| {
            // Unreachable in practice (nothing in this builder can fail except the
            // TLS backend), and a panic is honest: a shell with no HTTP client is
            // not a shell.
            unreachable!("the HTTP client could not be built: {error}")
        })
}

/// Stream one completion. `on_event` carries the contract documented in
/// `stream.rs`; `request.request_id` is the key `llm_cancel` uses.
///
/// The command RETURNS as soon as the work is scheduled: the response arrives on
/// the channel, not as a return value, because a stream cannot be a return value.
///
/// Deliberately NOT `pub`: `#[tauri::command]` defines two helper macros named
/// after the function, and `pub` makes those macros exported *and* re-imported
/// into this module, which the macro namespace rejects as a duplicate definition.
/// `generate_handler!` below is in this module, so it does not need the visibility.
#[tauri::command]
async fn llm_stream(
    request: LlmStreamRequest,
    on_event: tauri::ipc::Channel<LlmStreamEvent>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let request_id = request.request_id.clone();
    let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
    state
        .streams
        .entries()
        .insert(request_id.clone(), cancel_tx);

    // The client is cloned (it is an `Arc` inside) and the handles are an `Arc`, so
    // the spawned task owns everything it touches: `State<'_>` borrows the command
    // invocation and cannot outlive it.
    let client = state.client().clone();
    let streams = Arc::clone(&state.streams);

    tauri::async_runtime::spawn(async move {
        if let Err(error) = stream::run(StreamContext {
            request: &request,
            client: &client,
            cancel: cancel_rx,
            events: &on_event,
        })
        .await
        {
            // No request URL and no headers: a log is one of the places a key must
            // never reach (HANDOFF §4.1 invariant 6).
            eprintln!("[smarttavern] a stream could not report its outcome: {error}");
        }
        // Resolved last and unconditionally, so a finished stream can never leave
        // its cancel handle behind.
        streams.entries().remove(&request_id);
    });

    Ok(())
}

/// Stop an in-flight stream. Cancelling a request that already finished is not an
/// error: the UI's abort handler races the stream's natural end, and a spurious
/// failure there would surface as a confusing message after a successful answer.
///
/// Not `pub` for the same macro-namespace reason as `llm_stream`.
#[tauri::command]
async fn llm_cancel(request_id: String, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(cancel) = state.streams.entries().remove(&request_id) {
        // `send` fails only when the receiver is gone, which means the stream has
        // already finished; nothing to report either way.
        let _ = cancel.send(true);
    }
    Ok(())
}

/// The binary entry point.
///
/// The window itself is DECLARED in `tauri.conf.json` (`app.windows[0]`, label
/// `main`) and created by Tauri when the event loop reaches `Ready`. Nothing is built
/// here on purpose — see the note in the setup closure for what an earlier revision
/// got wrong by creating a second, same-labelled window in code.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let result = tauri::Builder::default()
        .manage(AppState::new(http_client()))
        .invoke_handler(tauri::generate_handler![llm_stream, llm_cancel])
        .setup(|app| {
            // ONE place creates the window, and it is `tauri.conf.json` (see the
            // `app.windows` entry). An earlier revision ALSO built a window here with
            // the same label, which is a duplicate the config cannot express: `Ready`
            // fires the config windows first, so the second build either collides on
            // the label or races WebView2 environment creation.
            //
            // The failure mode this shell actually has is "a window that shows
            // nothing", which from outside the process is indistinguishable from a
            // working window nobody looked at. One line naming the URL the window is
            // on is what makes those two distinguishable.
            match app.get_webview_window("main") {
                Some(window) => eprintln!(
                    "[smarttavern] window \"main\" is up (url: {:?})",
                    window.url().map(|url| url.to_string())
                ),
                None => eprintln!(
                    "[smarttavern] tauri.conf.json declares no \"main\" window — nothing will be shown"
                ),
            }
            Ok(())
        })
        .run(tauri::generate_context!());

    if let Err(error) = result {
        eprintln!(
            "[smarttavern] the shell exited with an error: {error}\n\
             hint: the window loads apps/desktop/dist — run \
             `pnpm --filter @smarttavern/desktop build` before launching a release build"
        );
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::{http_client, AppState};

    #[test]
    fn state_starts_with_no_streams_and_a_usable_client() {
        let state = AppState::new(http_client());
        assert!(state.streams.entries().is_empty());
        // The client is usable: building it is where rustls is selected, so failing
        // here would mean the transport cannot work at all.
        let _ = state.client();
    }

    #[test]
    fn cancelling_an_unknown_request_is_not_an_error() {
        let state = AppState::new(http_client());
        // A missing key is a no-op, not a failure (see `llm_cancel`).
        assert!(state.streams.entries().remove("nobody").is_none());
    }
}
