//! Hand-written base64 encoding for the IPC boundary.
//!
//! WHY BASE64 AND NOT TEXT. Rust reads the provider's response body as raw bytes
//! and forwards them untouched. Decoding those bytes to `String` per chunk would
//! corrupt a multi-byte UTF-8 character that a network chunk happened to split
//! (the classic case is a 4-byte emoji straddling two chunks: each half is
//! invalid UTF-8, so a per-chunk decode yields U+FFFD on both sides and the
//! character is lost). Base64 moves the bytes across the IPC boundary intact and
//! lets JavaScript reassemble them with a *streaming* `TextDecoder`, which is the
//! only place that can hold the partial sequence. Rust is the one side that must
//! not interpret the body at all — it is a byte pipe (docs/02 §6).
//!
//! WHY HAND-WRITTEN AND NOT A CRATE. The whole encoder is ~30 lines against a
//! fixed 64-character alphabet, and `docs/06-开发任务拆解.md` §9.2's spirit is that
//! a local-first app should not add a dependency it cannot audit for something
//! this small. It is unit-tested against known vectors, including a multi-byte
//! character split across two chunks, which is the case that motivated the
//! byte-level contract in the first place.

/// The standard base64 alphabet (RFC 4648 §4), as bytes so encoding is table
/// lookups rather than arithmetic on characters.
const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Padding character; emitted only to fill the final group of four.
const PAD: u8 = b'=';

/// Encode bytes as standard base64 with padding.
///
/// One group of three input bytes becomes four output characters; a trailing
/// group of one or two bytes is padded with `=`. An empty input encodes to an
/// empty string, which is what an empty chunk should look like on the wire.
pub fn encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    // `as_chunks` (not `chunks_exact`) because the group is a fixed-size array: the
    // six bytes are then read without an index that the compiler cannot check, and
    // the remainder comes back as a separate slice.
    let (groups, rest) = bytes.as_chunks::<3>();
    for group in groups {
        let (first, second, third) = (group[0], group[1], group[2]);
        out.push(ALPHABET[(first >> 2) as usize] as char);
        out.push(ALPHABET[(((first & 0b0000_0011) << 4) | (second >> 4)) as usize] as char);
        out.push(ALPHABET[(((second & 0b0000_1111) << 2) | (third >> 6)) as usize] as char);
        out.push(ALPHABET[(third & 0b0011_1111) as usize] as char);
    }
    match rest {
        [] => {}
        [only] => {
            out.push(ALPHABET[(only >> 2) as usize] as char);
            out.push(ALPHABET[((only & 0b0000_0011) << 4) as usize] as char);
            out.push(PAD as char);
            out.push(PAD as char);
        }
        [first, second] => {
            out.push(ALPHABET[(first >> 2) as usize] as char);
            out.push(ALPHABET[(((first & 0b0000_0011) << 4) | (second >> 4)) as usize] as char);
            out.push(ALPHABET[((second & 0b0000_1111) << 2) as usize] as char);
            out.push(PAD as char);
        }
        // A group of three can only leave 0, 1 or 2 bytes behind.
        _ => unreachable!("the remainder of groups of three is at most 2 bytes"),
    }
    out
}

#[cfg(test)]
mod tests {
    use super::encode;

    /// The canonical vectors: every remainder length, plus the empty input.
    #[test]
    fn matches_known_vectors() {
        assert_eq!(encode(b""), "");
        assert_eq!(encode(b"f"), "Zg==");
        assert_eq!(encode(b"fo"), "Zm8=");
        assert_eq!(encode(b"foo"), "Zm9v");
        assert_eq!(encode(b"foob"), "Zm9vYg==");
        assert_eq!(encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(encode(b"foobar"), "Zm9vYmFy");
    }

    /// RFC 4648 §10 also pins the high/low byte combinations, which is where a
    /// wrong shift shows up instead of a wrong table index. The same pair of
    /// vectors is asserted from the decoding side by the TypeScript transport's
    /// test, so a shift error has to be symmetric to survive both.
    #[test]
    fn matches_rfc4648_section_10_vectors() {
        assert_eq!(
            encode(&[0x00, 0x10, 0x83, 0x10, 0x51, 0x87, 0x20, 0x92, 0x8b]),
            "ABCDEFGHIJKL"
        );
        assert_eq!(encode(&[0xfb, 0xff]), "+/8=");
        assert_eq!(encode(&[0xff, 0xff, 0xff]), "////");
    }

    /// THE CASE THE WHOLE BYTE-LEVEL DESIGN EXISTS FOR: a 4-byte UTF-8 character
    /// (U+1F409) split across two chunks.
    ///
    /// Each half is encoded independently, padding and all, and each half decodes
    /// back to its own bytes; concatenating the BYTES reproduces the character,
    /// which is exactly what JavaScript does before feeding a streaming
    /// `TextDecoder`. Note this is deliberately not "concatenate the two base64
    /// strings and decode once": padding in the middle makes that invalid base64,
    /// which is why the contract is per-chunk bytes rather than one accumulated
    /// payload.
    #[test]
    fn a_multibyte_character_split_across_two_chunks_round_trips() {
        let whole = "🐉".as_bytes();
        assert_eq!(whole.len(), 4);
        let (head, tail) = whole.split_at(2);

        // Padding appears in the middle of the rendered halves, which is the trap.
        assert_eq!(
            (encode(head).as_str(), encode(tail).as_str()),
            ("8J8=", "kIk=")
        );
        assert_eq!(encode(whole), "8J+QiQ==");

        // Decoding each half and joining the bytes is what survives. The decoder
        // here is the dev-dependency: a trusted, independently tested one. A
        // hand-written decoder in the test could share a bug with the hand-written
        // encoder and still agree with it, which is the one failure mode this test
        // must not have.
        use base64::Engine as _;
        let rejoined: Vec<u8> = [encode(head), encode(tail)]
            .iter()
            .flat_map(|part| {
                base64::engine::general_purpose::STANDARD
                    .decode(part)
                    .expect("our own encoder produced something a standard decoder rejects")
            })
            .collect();
        assert_eq!(rejoined, whole);
        assert_eq!(String::from_utf8(rejoined).expect("utf-8"), "🐉");
    }

    /// `str::as_bytes` is UTF-8 by definition, so any text survives the round trip
    /// through the encoder — including the CJK content the app actually sends.
    #[test]
    fn encodes_utf8_text_without_loss() {
        assert_eq!(encode("你好".as_bytes()), "5L2g5aW9");
        assert_eq!(encode("龙".as_bytes()), "6b6Z");
    }
}
