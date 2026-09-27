/**
 * The SSE parser, on its own: this is pure string logic and the only part of the
 * adapter that can be wrong without a socket to blame, so every framing rule it
 * claims to implement is pinned here.
 *
 * The rules come from WHATWG HTML "Server-sent events", plus the two deliberate
 * deviations documented on `SseParser` (`flush()` dispatching a payload whose
 * blank line never arrived) and on the retry field.
 */
import { describe, expect, it } from 'vitest';
import { parseSseStream, SseParser } from './sse';

/** Collect everything one parser produces from a list of chunks. */
function messagesFrom(chunks: readonly string[]): ReturnType<SseParser['push']> {
  const parser = new SseParser();
  const messages = chunks.flatMap((chunk) => parser.push(chunk));
  return [...messages, ...parser.flush()];
}

/** Feed an async source (what the adapter does with a real body). */
async function collectStream(chunks: readonly string[]): Promise<unknown[]> {
  async function* source() {
    for (const chunk of chunks) yield chunk;
  }
  const out: unknown[] = [];
  for await (const message of parseSseStream(source())) out.push(message);
  return out;
}

describe('SseParser', () => {
  it('dispatches one message per blank line', () => {
    expect(messagesFrom(['data: one\n\ndata: two\n\n'])).toEqual([
      { event: 'message', data: 'one' },
      { event: 'message', data: 'two' },
    ]);
  });

  it('does not assume one chunk is one event', () => {
    // Three events in one chunk…
    expect(messagesFrom(['data: a\n\ndata: b\n\ndata: c\n\n'])).toHaveLength(3);
    // …one event spread over five chunks…
    expect(messagesFrom(['da', 'ta: he', 'llo', '\n', '\n'])).toEqual([
      { event: 'message', data: 'hello' },
    ]);
    // …and a chunk that ends exactly on a boundary.
    const parser = new SseParser();
    expect(parser.push('data: a\n')).toEqual([]);
    expect(parser.push('\n')).toEqual([{ event: 'message', data: 'a' }]);
  });

  it('joins multi-line data with a newline', () => {
    expect(messagesFrom(['data: line one\ndata: line two\n\n'])).toEqual([
      { event: 'message', data: 'line one\nline two' },
    ]);
  });

  it('strips exactly one leading space from a value', () => {
    expect(messagesFrom(['data:  padded\n\ndata:nospace\n\n'])).toEqual([
      { event: 'message', data: ' padded' },
      { event: 'message', data: 'nospace' },
    ]);
  });

  it('ignores comments, unknown fields and a field with no colon', () => {
    const chunks = [': keep-alive\n\n', 'x-vendor: 7\ndata: kept\n\n', 'lonely\n\n'];
    expect(messagesFrom(chunks)).toEqual([{ event: 'message', data: 'kept' }]);
  });

  it('accepts CRLF and a lone CR as line terminators', () => {
    expect(messagesFrom(['data: crlf\r\n\r\n'])).toEqual([{ event: 'message', data: 'crlf' }]);
    expect(messagesFrom(['data: cr\r\r'])).toEqual([{ event: 'message', data: 'cr' }]);
  });

  it('holds back a CR that may be half of a split CRLF', () => {
    const parser = new SseParser();
    // The trailing CR is ambiguous until the next chunk shows what follows.
    expect(parser.push('data: split\r')).toEqual([]);
    expect(parser.push('\n\r\n')).toEqual([{ event: 'message', data: 'split' }]);
  });

  it('names the event and remembers the id', () => {
    expect(messagesFrom(['event: ping\nid: 42\ndata: pong\n\n'])).toEqual([
      { event: 'ping', data: 'pong', id: '42' },
    ]);
    // The id is carried forward until another one replaces it.
    expect(messagesFrom(['id: 7\ndata: a\n\ndata: b\n\n'])).toEqual([
      { event: 'message', data: 'a', id: '7' },
      { event: 'message', data: 'b', id: '7' },
    ]);
  });

  it('surfaces a numeric retry field and ignores a malformed one', () => {
    expect(messagesFrom(['retry: 3000\ndata: a\n\n'])).toEqual([
      { event: 'message', data: 'a', retry: 3000 },
    ]);
    expect(messagesFrom(['retry: soon\ndata: a\n\n'])).toEqual([{ event: 'message', data: 'a' }]);
  });

  it('dispatches a payload whose blank line never arrived', () => {
    // Deliberate deviation from WHATWG: gateways drop the final blank line, and
    // losing the last answer is worse than accepting a payload we can validate.
    expect(messagesFrom(['data: last'])).toEqual([{ event: 'message', data: 'last' }]);
    expect(messagesFrom(['data: last\n'])).toEqual([{ event: 'message', data: 'last' }]);
  });

  it('returns nothing for a stream that carried no data', () => {
    expect(messagesFrom([])).toEqual([]);
    expect(messagesFrom(['\n\n', ': only a comment\n\n'])).toEqual([]);
  });

  it('is reusable through parseSseStream', async () => {
    expect(await collectStream(['data: {"a":1}\n\n', 'data: [DONE]\n\n'])).toEqual([
      { event: 'message', data: '{"a":1}' },
      { event: 'message', data: '[DONE]' },
    ]);
  });
});
