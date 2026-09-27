//! Integration tests for the transport: the shared cross-language fixture, URL
//! refusal, and real end-to-end streams against a local HTTP server.
//!
//! WHY THE SERVER IS HAND-ROLLED. The e2e case needs a server under the test's own
//! control — it has to dribble a body out in chunks and then observe whether the
//! client really hung up — and `docs/06-开发任务拆解.md` §9.2's rule about not
//! adding a dependency for something auditable applies here too. A
//! `std::net::TcpListener` in a thread speaking just enough HTTP/1.1 is ~60 lines
//! and, unlike a mock, it exercises the real socket path, the real chunking and the
//! real cancellation.
//!
//! The fixture test is the drift alarm: the same JSON is fed to the TypeScript
//! transport by `src/transport/tauri-fetch.test.ts`, so if either side changes the
//! event shape the other side's suite goes red.
//!
//! The sink is a `tokio::sync::mpsc` channel rather than a `tauri::ipc::Channel`,
//! which cannot exist outside a running app; `stream::EventSink` exists so the real
//! `run` loop is still what is being tested.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use smarttavern_desktop_lib::error::{TransportError, TransportErrorKind};
use smarttavern_desktop_lib::stream::{
    self, CancelSlot, EventSink, LlmStreamEvent, LlmStreamRequest, StreamContext,
};

/* ───────────────────────────── the drift alarm ───────────────────────────── */

/// The fixture as `serde_json::Value`: what the TypeScript side also reads.
fn fixture() -> Value {
    let path = "../src/transport/fixtures/llm-stream-events.json";
    let raw = std::fs::read_to_string(path)
        .unwrap_or_else(|error| panic!("{path} is missing or unreadable: {error}"));
    serde_json::from_str(&raw).expect("the fixture must be valid JSON")
}

/// Every event the transport can produce must serialise to exactly the JSON the TS
/// transport reads, and deserialise back from it.
///
/// A round trip on its own is too weak (two symmetric renames would pass), so each
/// entry is compared as a `Value` against the fixture text as well: the `type` tag,
/// the `dataBase64` spelling and the `kind`/`message` pair are all pinned here.
#[test]
fn every_event_kind_round_trips_to_the_shared_fixture_json() {
    let fixture = fixture();
    let events = fixture["events"].as_array().expect("events[]");
    assert_eq!(events.len(), 4, "the fixture pins all four event kinds");

    for expected in events {
        let event: LlmStreamEvent = serde_json::from_value(expected.clone())
            .unwrap_or_else(|error| panic!("{expected} did not deserialize: {error}"));
        let actual = serde_json::to_value(&event).expect("reserialize");
        assert_eq!(&actual, expected, "the event wire shape drifted");
    }
}

/// The `error` variant is the one the fixture cannot show (a successful stream has
/// no error in it), so all four kinds are pinned here by hand.
#[test]
fn the_error_variant_pins_every_kind_and_field_name() {
    for kind in [
        TransportErrorKind::Network,
        TransportErrorKind::Timeout,
        TransportErrorKind::Cancelled,
        TransportErrorKind::Protocol,
    ] {
        let event = LlmStreamEvent::Error(TransportError::new(kind, "boom"));
        let value = serde_json::to_value(&event).expect("serialize");
        assert_eq!(value["type"], json!("error"));
        assert_eq!(
            value["kind"],
            serde_json::to_value(kind).expect("kind"),
            "kind must stay a lower-camel string"
        );
        assert_eq!(value["message"], json!("boom"));
        assert_eq!(
            value.as_object().expect("object").len(),
            3,
            "no extra fields: {value}"
        );
        // And it deserialises back.
        let parsed: LlmStreamEvent = serde_json::from_value(value).expect("deserialize");
        assert!(matches!(parsed, LlmStreamEvent::Error(_)));
    }
    // The exact camelCase spelling of the variants themselves.
    assert_eq!(
        serde_json::to_value(LlmStreamEvent::Response {
            status: 200,
            headers: vec![("a".to_string(), "b".to_string())],
        })
        .expect("serialize"),
        json!({ "type": "response", "status": 200, "headers": [["a", "b"]] })
    );
    assert_eq!(
        serde_json::to_value(LlmStreamEvent::Chunk {
            data_base64: "AA==".to_string(),
        })
        .expect("serialize"),
        json!({ "type": "chunk", "dataBase64": "AA==" })
    );
    assert_eq!(
        serde_json::to_value(LlmStreamEvent::End).expect("serialize"),
        json!({ "type": "end" })
    );
}

/// The request half of the fixture is the contract the TS side sends.
#[test]
fn the_fixture_request_deserializes_and_its_chunks_reassemble() {
    let request: LlmStreamRequest =
        serde_json::from_value(fixture()["request"].clone()).expect("request");
    assert_eq!(request.request_id, "req-fixture-1");
    assert_eq!(request.method, "POST");
    assert_eq!(request.timeout_ms, Some(30_000));
    assert_eq!(request.headers.len(), 3);
    assert_eq!(request.headers[2].0, "authorization");

    // The two chunk payloads must reassemble into the fixture's expected body.
    // A 4-byte emoji is deliberately split across them, so this also pins that the
    // transport moves bytes rather than text.
    let mut bytes = Vec::new();
    for event in fixture()["events"].as_array().expect("events[]") {
        if event["type"] == json!("chunk") {
            use base64::Engine as _;
            let payload = event["dataBase64"].as_str().expect("dataBase64");
            bytes.extend(
                base64::engine::general_purpose::STANDARD
                    .decode(payload)
                    .expect("base64"),
            );
        }
    }
    assert_eq!(
        String::from_utf8(bytes).expect("the reassembled body is valid UTF-8"),
        fixture()["expected"]["text"]
            .as_str()
            .expect("expected.text")
    );
}

/* ────────────────────────────── URL refusal ─────────────────────────────── */

/// A local file must never be readable through the transport, and the refusal must
/// be a classified `protocol` error rather than a hang, a panic or a leak.
#[tokio::test]
async fn a_dangerous_url_is_refused_with_a_protocol_error() {
    for url in [
        "file:///C:/Users/me/.ssh/id_rsa",
        "javascript:alert(document.cookie)",
        "data:text/plain;base64,aGk=",
        "http://api.example.test/v1/chat/completions",
    ] {
        let (handle, _cancel) = spawn_stream(request(url, Some(1_000)));
        let events = collect(handle).await;
        assert_eq!(events.len(), 1, "{url}: {events:?}");
        match &events[0] {
            LlmStreamEvent::Error(error) => {
                assert_eq!(
                    serde_json::to_value(error).expect("serialize")["kind"],
                    json!("protocol"),
                    "{url}"
                );
            }
            other => panic!("{url} should have been refused, got {other:?}"),
        }
    }
}

/* ─────────────────────────────── real streams ───────────────────────────── */

#[tokio::test]
async fn streams_status_headers_and_reassembled_bytes() {
    let body = "data: {\"choices\":[{\"delta\":{\"content\":\"你好🐉\"},\"index\":0}]}\n\n\
                data: [DONE]\n\n";
    let server = TestServer::start(move |_request, mut stream| {
        write!(
            stream,
            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-cache\r\n\r\n"
        )
        .expect("head");
        // Split mid-character on purpose: the transport must not care.
        let bytes = body.as_bytes();
        let cut = bytes.len() / 2;
        stream.write_all(&bytes[..cut]).expect("first half");
        stream.flush().expect("flush");
        std::thread::sleep(Duration::from_millis(20));
        stream.write_all(&bytes[cut..]).expect("second half");
        stream.flush().expect("flush");
    });

    let (handle, _cancel) = spawn_stream(request(&server.url("/v1/chat/completions"), Some(5_000)));
    let events = collect(handle).await;

    match &events[0] {
        LlmStreamEvent::Response { status, headers } => {
            assert_eq!(*status, 200);
            assert!(
                headers.contains(&("content-type".to_string(), "text/event-stream".to_string()))
            );
        }
        other => panic!("expected a response head, got {other:?}"),
    }

    let mut bytes = Vec::new();
    for event in &events {
        if let LlmStreamEvent::Chunk { data_base64 } = event {
            use base64::Engine as _;
            bytes.extend(
                base64::engine::general_purpose::STANDARD
                    .decode(data_base64)
                    .expect("base64"),
            );
        }
    }
    assert_eq!(String::from_utf8(bytes).expect("utf-8"), body);
    assert!(
        matches!(events.last(), Some(LlmStreamEvent::End)),
        "{events:?}"
    );
}

/// A 401 and a 429 are EVENTS, not transport failures: `openai-compatible.ts`
/// classifies them (auth / rate_limit) and needs `status`, `Retry-After` and the
/// vendor body to do it. A Rust side that short-circuited them would break the four
/// mappings without a single test on this side failing.
#[tokio::test]
async fn a_non_2xx_status_passes_through_with_its_headers_and_body() {
    for (status_line, status, retry_after) in [
        ("HTTP/1.1 401 Unauthorized", 401_u16, None),
        ("HTTP/1.1 429 Too Many Requests", 429, Some("2")),
    ] {
        let body = "{\"error\":{\"code\":\"insufficient_quota\",\"message\":\"nope\"}}";
        let server = TestServer::start(move |_request, mut stream| {
            write!(
                stream,
                "{status_line}\r\ncontent-type: application/json\r\n"
            )
            .expect("status");
            if let Some(seconds) = retry_after {
                write!(stream, "retry-after: {seconds}\r\n").expect("retry-after");
            }
            write!(stream, "content-length: {}\r\n\r\n{body}", body.len()).expect("body");
        });

        let (handle, _cancel) = spawn_stream(request(&server.url("/v1/chat/completions"), None));
        let events = collect(handle).await;

        match &events[0] {
            LlmStreamEvent::Response {
                status: seen,
                headers,
            } => {
                assert_eq!(*seen, status);
                if let Some(seconds) = retry_after {
                    assert!(
                        headers.contains(&("retry-after".to_string(), seconds.to_string())),
                        "Retry-After must survive: {headers:?}"
                    );
                }
            }
            other => panic!("expected a response head, got {other:?}"),
        }
        let mut bytes = Vec::new();
        for event in &events {
            if let LlmStreamEvent::Chunk { data_base64 } = event {
                use base64::Engine as _;
                bytes.extend(
                    base64::engine::general_purpose::STANDARD
                        .decode(data_base64)
                        .unwrap(),
                );
            }
        }
        assert_eq!(String::from_utf8(bytes).expect("utf-8"), body);
        assert!(
            matches!(events.last(), Some(LlmStreamEvent::End)),
            "{events:?}"
        );
        // No `error` event: the classification is JavaScript's job.
        assert!(
            !events
                .iter()
                .any(|event| matches!(event, LlmStreamEvent::Error(_))),
            "{events:?}"
        );
    }
}

/// `llm_cancel` must stop the upstream request, not just hide it: an LLM that keeps
/// generating costs the user money. The server keeps producing until the client
/// hangs up, so the test can prove the socket was dropped.
#[tokio::test]
async fn cancel_stops_the_upstream_request() {
    let emitted = Arc::new(AtomicUsize::new(0));
    let first_chunk = Arc::new(AtomicBool::new(false));
    let server_emitted = Arc::clone(&emitted);
    let server_first = Arc::clone(&first_chunk);
    let server = TestServer::start(move |_request, mut stream| {
        if write!(
            stream,
            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n\r\n"
        )
        .is_err()
        {
            return;
        }
        for index in 0..200 {
            let frame = format!("data: {{\"index\":{index}}}\n\n");
            if stream.write_all(frame.as_bytes()).is_err() || stream.flush().is_err() {
                break;
            }
            server_emitted.fetch_add(1, Ordering::SeqCst);
            server_first.store(true, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(40));
        }
    });

    let (handle, cancel) = spawn_stream(request(&server.url("/v1/chat/completions"), None));
    // Wait until the stream is genuinely mid-body, then cancel: exactly the UI's
    // sequence of "the user pressed stop while tokens were arriving".
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !first_chunk.load(Ordering::SeqCst) {
        assert!(
            std::time::Instant::now() < deadline,
            "the server never produced a chunk"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let _ = cancel.send(true);

    let events = collect(handle).await;
    match events.last() {
        Some(LlmStreamEvent::Error(error)) => assert_eq!(
            serde_json::to_value(error).expect("serialize")["kind"],
            json!("cancelled"),
            "{events:?}"
        ),
        other => panic!("expected a cancelled error, got {other:?}"),
    }

    // The server must stop promptly. Without real cancellation it would produce 200
    // chunks over eight seconds, so anything near that means the socket outlived the
    // user's decision.
    tokio::time::sleep(Duration::from_millis(400)).await;
    let written = emitted.load(Ordering::SeqCst);
    assert!(
        written < 15,
        "the upstream request was not stopped ({written} chunks)"
    );
}

/// `timeout_ms` is the caller's budget and must be enforced even when the server
/// answers nothing at all.
#[tokio::test]
async fn a_silent_server_times_out() {
    let server = TestServer::start(|_request, stream| {
        // Accept the request, answer nothing, hold the connection open.
        std::thread::sleep(Duration::from_secs(5));
        drop(stream);
    });

    let (handle, _cancel) = spawn_stream(request(&server.url("/v1/chat/completions"), Some(150)));
    let events = collect(handle).await;
    match events.last() {
        Some(LlmStreamEvent::Error(error)) => assert_eq!(
            serde_json::to_value(error).expect("serialize")["kind"],
            json!("timeout"),
            "{events:?}"
        ),
        other => panic!("expected a timeout error, got {other:?}"),
    }
}

/// An unreachable endpoint fails as `network`, and no text this side produces may
/// contain the `Authorization` value (HANDOFF §4.1 invariant 6).
#[tokio::test]
async fn a_network_failure_reports_no_authorization_value() {
    // A port that has just been released: nothing is listening on it anymore.
    let port = {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        listener.local_addr().expect("addr").port()
    };
    let secret = "Bearer sk-live-DO-NOT-LEAK-0123456789";
    let mut request = request(
        &format!("http://127.0.0.1:{port}/v1/chat/completions"),
        None,
    );
    request
        .headers
        .push(("authorization".to_string(), secret.to_string()));

    let (handle, _cancel) = spawn_stream(request);
    let events = collect(handle).await;
    let rendered = serde_json::to_string(&events).expect("serialize");
    assert!(!rendered.contains(secret), "{rendered}");
    assert!(!rendered.contains("DO-NOT-LEAK"), "{rendered}");
    match events.last() {
        Some(LlmStreamEvent::Error(error)) => {
            let value = serde_json::to_value(error).expect("serialize");
            assert_eq!(value["kind"], json!("network"), "{value}");
            assert!(
                value["message"]
                    .as_str()
                    .expect("message")
                    .contains("127.0.0.1"),
                "{value}"
            );
        }
        other => panic!("expected a network error, got {other:?}"),
    }
}

/// A body that stops mid-frame must be reported: the bytes that did arrive are
/// delivered first, then the failure. Silently ending would make a truncated answer
/// look like a finished one.
#[tokio::test]
async fn a_body_cut_mid_stream_is_reported_after_the_delivered_bytes() {
    let server = TestServer::start(|_request, mut stream| {
        write!(
            stream,
            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: 1000\r\n\r\n"
        )
        .expect("head");
        stream.write_all(b"data: {\"partial\"").expect("partial");
        stream.flush().expect("flush");
        // Dropping the socket while the announced body is incomplete.
        drop(stream);
    });

    let (handle, _cancel) = spawn_stream(request(&server.url("/v1/chat/completions"), Some(3_000)));
    let events = collect(handle).await;
    assert!(
        events
            .iter()
            .any(|event| matches!(event, LlmStreamEvent::Chunk { .. })),
        "the delivered bytes must not be thrown away: {events:?}"
    );
    assert!(
        matches!(events.last(), Some(LlmStreamEvent::Error(_))),
        "a truncated body must be reported: {events:?}"
    );
}

/* ──────────────────────────── helpers and the server ─────────────────────── */

fn request(url: &str, timeout_ms: Option<u64>) -> LlmStreamRequest {
    LlmStreamRequest {
        request_id: format!("test-{}", url.len()),
        url: url.to_string(),
        method: "POST".to_string(),
        headers: vec![
            ("content-type".to_string(), "application/json".to_string()),
            (
                "authorization".to_string(),
                "Bearer sk-test-1234".to_string(),
            ),
        ],
        body: "{\"stream\":true}".to_string(),
        timeout_ms,
    }
}

/// A sink that collects events in order, so the real `stream::run` can be driven
/// without a running Tauri app.
struct CollectingSink(tokio::sync::mpsc::Sender<LlmStreamEvent>);

impl EventSink for CollectingSink {
    fn send(&self, event: LlmStreamEvent) -> Result<(), String> {
        self.0
            .try_send(event)
            .map_err(|error| format!("the test sink is gone: {error}"))
    }
}

/// Start `stream::run` on the current runtime and hand back its output plus the
/// cancel handle, exactly the way `llm_stream` does.
fn spawn_stream(
    request: LlmStreamRequest,
) -> (tokio::task::JoinHandle<Vec<LlmStreamEvent>>, CancelSlot) {
    let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
    let (events_tx, mut events_rx) = tokio::sync::mpsc::channel::<LlmStreamEvent>(512);
    let client = smarttavern_desktop_lib::http_client();
    let sink = CollectingSink(events_tx);

    let handle = tokio::spawn(async move {
        let outcome = stream::run(StreamContext {
            request: &request,
            client: &client,
            cancel: cancel_rx,
            events: &sink,
        })
        .await;
        assert!(
            outcome.is_ok(),
            "the transport could not report: {outcome:?}"
        );
        drop(sink);

        let mut collected = Vec::new();
        while let Some(event) = events_rx.recv().await {
            collected.push(event);
        }
        collected
    });
    (handle, cancel_tx)
}

/// Wait for `stream::run` to finish. It always ends in `end` or `error`, so a
/// timeout here is a hang in the transport, not a slow test.
async fn collect(handle: tokio::task::JoinHandle<Vec<LlmStreamEvent>>) -> Vec<LlmStreamEvent> {
    tokio::time::timeout(Duration::from_secs(10), handle)
        .await
        .expect("the transport did not finish in time")
        .expect("the transport task panicked")
}

/// A minimal HTTP/1.1 server on a loopback port, one thread per connection.
struct TestServer {
    address: String,
    /// Held for the lifetime of the test so the port stays bound.
    _listener: Arc<TcpListener>,
}

impl TestServer {
    fn start<F>(handler: F) -> Self
    where
        F: Fn(String, TcpStream) + Send + Sync + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind a loopback port");
        let address = listener.local_addr().expect("local addr");
        let listener = Arc::new(listener);
        let shared = Arc::new(handler);
        let accepting = Arc::clone(&listener);
        std::thread::spawn(move || {
            for connection in accepting.incoming() {
                let Ok(stream) = connection else { break };
                let handler = Arc::clone(&shared);
                std::thread::spawn(move || {
                    if let Some(request) = read_request(&stream) {
                        handler(request, stream);
                    }
                });
            }
        });
        Self {
            address: format!("http://{address}"),
            _listener: listener,
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.address)
    }
}

/// Read one HTTP/1.1 request: the head, then exactly `content-length` body bytes.
/// The test server reads the body so the client's write cannot stall on a full
/// socket buffer, which would make the streaming assertions flaky.
fn read_request(stream: &TcpStream) -> Option<String> {
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let mut head = String::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).ok()? == 0 {
            return None;
        }
        head.push_str(&line);
        if line == "\r\n" || line == "\n" {
            break;
        }
    }
    let length = head
        .lines()
        .find_map(|line| {
            line.to_ascii_lowercase()
                .strip_prefix("content-length:")
                .and_then(|value| value.trim().parse::<usize>().ok())
        })
        .unwrap_or(0);
    if length > 0 {
        let mut body = vec![0u8; length];
        reader.read_exact(&mut body).ok()?;
        head.push_str(&String::from_utf8_lossy(&body));
    }
    Some(head)
}
