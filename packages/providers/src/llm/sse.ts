/**
 * Server-Sent Events parser — written by hand because `docs/06-开发任务拆解.md`
 * §9.2 forbids an HTTP/SSE dependency: a local-first app must not ship a parser
 * it cannot audit, and the wire format is small enough to own.
 *
 * THE FOUR THINGS A NAIVE SPLIT-ON-`\n\n` GETS WRONG, and this file does not:
 * 1. ONE CHUNK IS NOT ONE EVENT. A network chunk may carry half an event, three
 *    events, or an event boundary in the middle; the parser keeps a buffer and
 *    only reports a message when it has seen the terminator.
 * 2. `data:` MAY REPEAT. Multi-line payloads are joined with `\n` (WHATWG HTML
 *    §9.2.6), so a caller must not read the first `data:` line and stop.
 * 3. LINE TERMINATORS ARE `\r\n`, `\n` OR A LONE `\r`. A trailing `\r` may be
 *    the first half of a `\r\n` split across two chunks, so it is held back
 *    rather than treated as a line end.
 * 4. COMMENTS AND UNKNOWN FIELDS ARE LEGAL. `: keep-alive` and `x-vendor: …`
 *    must be ignored, not surfaced as payload — that is exactly how a gateway
 *    keeps a connection warm without confusing a strict client.
 *
 * `[DONE]` IS NOT PART OF THE SSE SPEC. It is an OpenAI stream convention: a
 * message whose data is literally `[DONE]`. This parser stays vendor-neutral and
 * hands it up as ordinary data; `openai-compatible.ts` is what recognises it.
 */

/** One dispatched SSE event (the spec's "event" once its blank line arrived). */
export interface SseMessage {
  /** `event:` field, or `'message'` when the stream did not name one. */
  readonly event: string;
  /** Every `data:` field of the event, joined with `\n`. Never empty. */
  readonly data: string;
  /** `id:` field, carried forward per spec, when one was ever seen. */
  readonly id?: string;
  /** `retry:` field of THIS event, in milliseconds, when it parsed as an integer. */
  readonly retry?: number;
}

/**
 * Incremental parser. Feed it decoded text as it arrives, then call `flush()`
 * once the body ends (a stream may omit the final blank line).
 */
export class SseParser {
  private buffer = '';
  private dataLines: string[] = [];
  private eventName = '';
  private lastEventId = '';
  private pendingRetry: number | undefined;

  /**
   * Consume one decoded chunk and return every message it completed, in order.
   * Returns `[]` when the chunk ended in the middle of a line or event — which
   * is the normal case on a slow connection, not an error.
   */
  push(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const messages: SseMessage[] = [];
    for (;;) {
      const terminator = findLineTerminator(this.buffer);
      if (terminator === undefined) break;
      const line = this.buffer.slice(0, terminator.index);
      this.buffer = this.buffer.slice(terminator.index + terminator.length);
      const message = this.consumeLine(line);
      if (message !== undefined) messages.push(message);
    }
    return messages;
  }

  /**
   * Close the stream. WHATWG discards an event that never saw its blank line;
   * we dispatch it instead, because gateways in the wild routinely omit the last
   * one and losing the final answer is worse than accepting a partial payload
   * (which the JSON layer then rejects on its own terms).
   */
  flush(): SseMessage[] {
    if (this.buffer === '') {
      const pending = this.dispatch();
      return pending === undefined ? [] : [pending];
    }
    // Appending a blank line terminates the held-back line AND dispatches.
    return this.push('\n\n');
  }

  /** Apply one complete line; returns a message only for a blank line (= dispatch). */
  private consumeLine(line: string): SseMessage | undefined {
    if (line === '') return this.dispatch();
    // A line starting with ':' is a comment (keep-alives live here).
    if (line.startsWith(':')) return undefined;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    // Exactly one leading space is part of the framing, not of the value.
    if (value.startsWith(' ')) value = value.slice(1);

    switch (field) {
      case 'data':
        this.dataLines.push(value);
        return undefined;
      case 'event':
        this.eventName = value;
        return undefined;
      case 'id':
        // The spec ignores an id containing NUL; keep the previous one.
        if (!value.includes('\u0000')) this.lastEventId = value;
        return undefined;
      case 'retry': {
        const parsed = parseRetry(value);
        if (parsed !== undefined) this.pendingRetry = parsed;
        return undefined;
      }
      default:
        // Unknown field: ignored, exactly as the spec requires.
        return undefined;
    }
  }

  private dispatch(): SseMessage | undefined {
    if (this.dataLines.length === 0) {
      this.eventName = '';
      return undefined;
    }
    const message: SseMessage = {
      event: this.eventName === '' ? 'message' : this.eventName,
      data: this.dataLines.join('\n'),
      ...(this.lastEventId === '' ? {} : { id: this.lastEventId }),
      ...(this.pendingRetry === undefined ? {} : { retry: this.pendingRetry }),
    };
    this.dataLines = [];
    this.eventName = '';
    this.pendingRetry = undefined;
    return message;
  }
}

/**
 * Index and width of the first line terminator, or `undefined` when the buffer
 * holds only an unterminated line. A CR at the very end is withheld: it may be
 * the leading half of a CRLF whose LF has not arrived yet.
 */
function findLineTerminator(text: string): { index: number; length: number } | undefined {
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\n') return { index, length: 1 };
    if (char === '\r') {
      if (index + 1 >= text.length) return undefined;
      return { index, length: text[index + 1] === '\n' ? 2 : 1 };
    }
  }
  return undefined;
}

/** `retry:` is a non-negative integer count of milliseconds; anything else is ignored. */
function parseRetry(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * Feed a source of decoded text chunks and yield every message it produces,
 * including the ones `flush()` recovers when the source ends without a blank
 * line. Kept here (not in the adapter) so a second provider can reuse it.
 */
export async function* parseSseStream(chunks: AsyncIterable<string>): AsyncGenerator<SseMessage> {
  const parser = new SseParser();
  for await (const chunk of chunks) {
    for (const message of parser.push(chunk)) yield message;
  }
  for (const message of parser.flush()) yield message;
}
