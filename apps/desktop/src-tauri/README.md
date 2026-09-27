# apps/desktop/src-tauri — the Tauri 2 shell

The native half of `apps/desktop` (M0-T8). `docs/02-技术架构.md` §3 defines this app
as a thin Tauri 2 shell that reuses the `apps/web` build output and adds native
capability; ADR-002 is the decision, ADR-003 is why one of those capabilities is an
HTTP client.

## What lives here

| Path | What it is |
| --- | --- |
| `src/lib.rs` | The shell: app state, the two Tauri commands, the window |
| `src/stream.rs` | The LLM transport — a byte pipe, not a second SSE implementation |
| `src/base64.rs` | Hand-written base64 for the byte-level IPC contract |
| `src/url_rules.rs` | Which URLs a request may be aimed at (and which it may not) |
| `src/error.rs` | The four transport-level error kinds and their messages |
| `src/main.rs` | Three lines: call the library |
| `tests/llm_transport.rs` | Fixture drift alarm, URL refusal, and end-to-end streams |

## Why a hand-written transport instead of `tauri-plugin-http`

`tauri-plugin-http` is a `fetch` shim over `reqwest`, which would be one more
dependency for a job that is already 200 lines — and it would put the request on the
plugin's own IPC surface. More importantly, the one thing this transport must do is
hand back a **real** `Response` whose `body` is a `ReadableStream`, so the
zero-dependency SSE parser in `packages/providers/src/llm/sse.ts` keeps working
untouched. That requirement is easier to satisfy directly than through a shim.

## The contract

```rust
#[tauri::command] async fn llm_stream(request: LlmStreamRequest, on_event: Channel<LlmStreamEvent>) -> Result<(), String>
#[tauri::command] async fn llm_cancel(request_id: String) -> Result<(), String>
```

Events, discriminated by `type` (see `src/transport/events.ts` for the TypeScript
half and `src/transport/fixtures/llm-stream-events.json` for the shared fixture):

- `{"type":"response","status":200,"headers":[["content-type","text/event-stream"]]}`
- `{"type":"chunk","dataBase64":"…"}` — raw bytes; an SSE frame can split a
  multi-byte character across two chunks, so text decoding happens once, in
  JavaScript, with a streaming `TextDecoder`
- `{"type":"end"}`
- `{"type":"error","kind":"network"|"timeout"|"cancelled"|"protocol","message":"…"}`

Nothing about a vendor lives on this side: a 401 is forwarded as a `response` and a
body, because `packages/providers/src/llm/openai-compatible.ts` is the one place that
classifies failures and it already has tests.

## Building

```sh
pnpm --filter @smarttavern/desktop build        # the frontend bundle into ../dist
pnpm --filter @smarttavern/desktop tauri:build  # the shell (adds --no-bundle)
pnpm --filter @smarttavern/desktop tauri:check  # fmt + clippy + tests
```

`tauri build` without `--no-bundle` downloads WiX/NSIS installers on Windows; the
`tauri:build` script passes `--no-bundle` for exactly that reason.

## Local machine notes

Windows schannel TLS is broken in the development sandbox, which is why the crate
uses `rustls` (`reqwest`'s `rustls-tls` feature) rather than the platform stack. That
choice is not only a workaround: one TLS implementation on every platform is also the
more predictable transport. Cargo itself reaches crates.io through a machine-local
mirror configured in `$CARGO_HOME/config.toml`; no project file refers to it, and none
should.
