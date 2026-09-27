//! Transport-level failure vocabulary — the only errors the Rust side is allowed
//! to name.
//!
//! THE LINE THIS FILE DRAWS (docs/02 §6, and the whole point of a thin shell): the
//! Rust side classifies *transport* failures and nothing else. It does not read
//! the status code, does not look for vendor error keys, does not decide whether a
//! failure is retryable and does not redact. A 401, a 429, a vendor's
//! `content_policy_violation` body — all of those arrive in JavaScript as an
//! ordinary `response` plus `chunk` events, where `openai-compatible.ts` already
//! classifies them with tests behind it. Duplicating that table here would create
//! a second source of truth for the four mappings the repo deliberately keeps in
//! one place.
//!
//! WHERE THE SPEC'S FOUR KINDS COME FROM:
//! - `network`  — the socket never opened, TLS failed, or the body died mid-stream.
//! - `timeout`  — the caller's `timeout_ms` budget elapsed, on headers or on a chunk.
//! - `cancelled`— `llm_cancel` won the race against the upstream chunk.
//! - `protocol` — a URL this shell refuses to fetch, or a response `reqwest`
//!   could not parse. The request itself was malformed, so retrying is pointless.

use serde::{Deserialize, Serialize};

/// Why a request failed, at the transport level only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TransportErrorKind {
    /// Never reached the provider, or the connection ended mid-body.
    Network,
    /// Exceeded the caller's budget.
    Timeout,
    /// The caller withdrew (`llm_cancel`).
    Cancelled,
    /// A URL or a response this transport will not handle.
    Protocol,
}

/// A transport failure, plus the sentence a human reads.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransportError {
    pub kind: TransportErrorKind,
    pub message: String,
}

impl TransportError {
    pub fn new(kind: TransportErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    /// Classify a `reqwest` failure.
    ///
    /// THE MESSAGE NEVER CONTAINS THE REQUEST. `reqwest`'s own `Display` renders
    /// the URL and the transport cause; the URL of an OpenAI-compatible endpoint
    /// can carry the key in a query string (`?api-key=…`, an Azure/Gemini-shaped
    /// habit) and the `Authorization` header value never appears in an error at
    /// all, which is what the "keys never reach logs" invariant (HANDOFF §4.1
    /// invariant 6) requires of this side.
    ///
    /// The URL is reported as scheme + host + path only: that is the part a person
    /// needs to know which endpoint failed, and it is the part that cannot carry a
    /// credential.
    pub fn from_reqwest(stage: &str, url: &str, error: &reqwest::Error) -> Self {
        if error.is_timeout() {
            return Self::new(
                TransportErrorKind::Timeout,
                format!("{stage}: the provider did not answer within the timeout"),
            );
        }
        if error.is_builder() || error.is_redirect() {
            return Self::new(
                TransportErrorKind::Protocol,
                format!("{stage}: the request could not be built or was redirected too often"),
            );
        }
        if error.is_body() || error.is_decode() {
            return Self::new(
                TransportErrorKind::Protocol,
                format!("{stage}: the response body could not be read"),
            );
        }
        Self::new(
            TransportErrorKind::Network,
            format!(
                "{stage}: the provider could not be reached at {}",
                safe_endpoint(url)
            ),
        )
    }

    /// A failure the caller asked for.
    pub fn cancelled() -> Self {
        Self::new(
            TransportErrorKind::Cancelled,
            "the request was cancelled".to_string(),
        )
    }

    /// A failure that is our own decision, not the network's.
    pub fn refused(message: impl Into<String>) -> Self {
        Self::new(TransportErrorKind::Protocol, message)
    }
}

/// `scheme://host/path` with the query and the userinfo removed, for error text.
fn safe_endpoint(url: &str) -> String {
    match reqwest::Url::parse(url) {
        Ok(parsed) => {
            let mut safe = parsed.clone();
            // A query string is where a hand-configured endpoint hides its key.
            safe.set_query(None);
            let _ = safe.set_username("");
            let _ = safe.set_password(None);
            safe.to_string()
        }
        // Unparseable: report nothing rather than the raw string.
        Err(_) => "<unparseable endpoint>".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::{safe_endpoint, TransportError, TransportErrorKind};

    #[test]
    fn strips_query_and_userinfo_from_reported_endpoints() {
        let safe = safe_endpoint("https://user:pass@api.example.test/v1/chat?api-key=sk-secret");
        assert!(!safe.contains("sk-secret"), "{safe}");
        assert!(!safe.contains("pass"), "{safe}");
        assert!(safe.contains("api.example.test/v1/chat"), "{safe}");
    }

    #[test]
    fn a_refusal_keeps_its_kind() {
        let error = TransportError::refused("nope");
        assert_eq!(error.kind, TransportErrorKind::Protocol);
        assert_eq!(
            TransportError::cancelled().kind,
            TransportErrorKind::Cancelled
        );
    }
}
