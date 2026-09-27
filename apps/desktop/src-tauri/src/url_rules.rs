//! The one security decision this shell makes on its own: which URLs a request
//! may be aimed at.
//!
//! WHY THIS EXISTS AT ALL. The desktop transport is reachable from the UI, and
//! the UI is reachable from an LLM's output and from a user-supplied base URL.
//! `reqwest` would happily `GET file:///C:/Users/me/.ssh/id_rsa` or a `data:` URL,
//! so a desktop shell that pipes arbitrary strings into HTTP is a local-file
//! reader wearing a network API's clothes. Refusing the odd schemes is the fix.
//!
//! WHAT IS REFUSED AND WHY: anything that is not `http`/`https` (`file:`,
//! `javascript:`, `data:`, `blob:`, `ftp:`, …), a URL with no host, and
//! cleartext `http` to anything but loopback. Plain `http` to a remote host would
//! put the `Authorization` header on the wire in the clear; loopback is exempt
//! because that is exactly how Ollama (`http://localhost:11434/v1`), LM Studio
//! and vLLM are reached, and a loopback socket never leaves the machine.
//!
//! WHAT IS DELIBERATELY *NOT* HERE: no allow-list of provider hostnames (BYO-Key
//! means the user names the host, ADR-003), no body inspection, no header policy.
//! A wrong-but-allowed host costs a failed request; this module only stops the
//! requests that must never be made at all.

use reqwest::Url;

/// Loopback hosts, compared case-insensitively. `[::1]` is spelled the way
/// `Url::host_str` reports an IPv6 literal (no brackets would be wrong here).
const LOOPBACK_HOSTS: [&str; 3] = ["localhost", "127.0.0.1", "[::1]"];

/// Reject a URL this transport must not fetch. The error is a sentence for a
/// human: it reaches the UI through the `error` event's `message`.
pub fn validate(url: &str) -> Result<(), String> {
    let parsed = Url::parse(url).map_err(|error| format!("unusable request URL: {error}"))?;

    let scheme = parsed.scheme().to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err(format!(
            "refusing to fetch a `{scheme}` URL: the desktop transport only speaks http and https"
        ));
    }

    let host = parsed
        .host_str()
        .ok_or_else(|| "refusing to fetch a URL without a host".to_string())?
        .to_ascii_lowercase();
    if scheme == "http" && !LOOPBACK_HOSTS.contains(&host.as_str()) {
        return Err(format!(
            "refusing cleartext http to `{host}`: only loopback may be reached over http, \
             because anything else would put the API key on the wire unencrypted"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate;

    #[test]
    fn accepts_https_anywhere() {
        assert!(validate("https://api.example.test/v1/chat/completions").is_ok());
        assert!(validate("https://api.deepseek.com/v1/chat/completions").is_ok());
        assert!(validate("HTTPS://API.EXAMPLE.TEST/v1/models").is_ok());
    }

    #[test]
    fn accepts_cleartext_http_on_loopback_only() {
        assert!(validate("http://localhost:11434/v1/chat/completions").is_ok());
        assert!(validate("http://LOCALHOST:11434/v1/models").is_ok());
        assert!(validate("http://127.0.0.1:8080/v1/models").is_ok());
        assert!(validate("http://[::1]:8080/v1/models").is_ok());
        assert!(validate("http://api.example.test/v1/models").is_err());
        // The near-misses that a naive `contains("localhost")` would let through.
        assert!(validate("http://localhost.evil.test/v1/models").is_err());
        assert!(validate("http://notlocalhost/v1/models").is_err());
    }

    #[test]
    fn rejects_local_file_and_script_schemes() {
        for url in [
            "file:///C:/Users/me/.ssh/id_rsa",
            "file://localhost/etc/passwd",
            "javascript:alert(1)",
            "data:text/plain;base64,aGk=",
            "blob:https://example.test/1234",
            "ftp://example.test/x",
            "//example.test/x",
            "not a url at all",
            "https://",
        ] {
            assert!(validate(url).is_err(), "{url} should have been refused");
        }
    }

    /// A refusal names the scheme it refused, so the UI can explain itself; it
    /// must never echo the whole URL, which may carry a query-string key.
    #[test]
    fn refusal_text_names_the_scheme_and_not_the_url() {
        let error = validate("file:///C:/secrets/keys.txt?token=abc").unwrap_err();
        assert!(error.contains("file"), "{error}");
        assert!(!error.contains("secrets"), "{error}");
        assert!(!error.contains("abc"), "{error}");
    }
}
