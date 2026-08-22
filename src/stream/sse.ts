/**
 * SSE-aware re-hydration.
 *
 * Byte-level buffering (see rehydrate.ts) is necessary but not sufficient: a
 * model does not emit `[EMAIL_1]` as one token, so the placeholder routinely
 * arrives spread over several *events*:
 *
 *     data: {"choices":[{"delta":{"content":"["}}]}
 *     data: {"choices":[{"delta":{"content":"EMAIL"}}]}
 *     data: {"choices":[{"delta":{"content":"_1]"}}]}
 *
 * So the stream is parsed into events, each event's delta fields are fed to a
 * re-hydrator that remembers across events (one per logical stream, keyed by
 * path and block index so two tool calls never mix), and every *other* string
 * in the event — which is complete by construction — is substituted directly.
 *
 * Deltas that are still incomplete when a block or the message ends are emitted
 * as one synthetic event modelled on the last real one, so nothing is ever
 * dropped and the client still sees a well-formed stream.
 */
import { mapStrings, selectByRules, type JsonValue, type Path, type PathRule } from '../redact/traverse.js';
import { StreamRehydrator, substituteComplete, type TokenResolver } from './rehydrate.js';

/** One parsed SSE event: the original lines plus the fields we care about. */
export interface SseEvent {
  /** The block exactly as received, without its terminating blank line. */
  readonly raw: string;
  readonly lines: readonly string[];
  /** The `event:` field, when the producer sent one. */
  readonly name: string | undefined;
  /** All `data:` values joined with newlines, per the SSE specification. */
  readonly data: string;
  readonly hasData: boolean;
}

/** Length of the line terminator at `index`, or 0 when there is none. */
function terminatorAt(text: string, index: number): number {
  const char = text[index];
  if (char === '\n') return 1;
  if (char !== '\r') return 0;
  if (text[index + 1] === '\n') return 2;
  // A lone CR at the very end may still turn into CRLF; wait for more input.
  return index + 1 < text.length ? 1 : 0;
}

/** Incremental SSE block parser. Feed it chunks; it yields complete events. */
export class SseParser {
  private buffer = '';
  private scanned = 0;

  push(text: string): SseEvent[] {
    this.buffer += text;
    const events: SseEvent[] = [];

    for (;;) {
      const boundary = this.findBoundary();
      if (boundary === null) break;

      const block = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary.length);
      this.scanned = 0;
      events.push(parseBlock(block));
    }

    // A terminator can straddle a chunk boundary, so never trust the last few
    // characters to have been scanned conclusively.
    this.scanned = Math.max(0, this.buffer.length - 3);
    return events;
  }

  /** Whatever is left in the buffer: an event the producer never finished. */
  flush(): string {
    const rest = this.buffer;
    this.buffer = '';
    this.scanned = 0;
    return rest;
  }

  private findBoundary(): { index: number; length: number } | null {
    for (let index = this.scanned; index < this.buffer.length; index += 1) {
      const first = terminatorAt(this.buffer, index);
      if (first === 0) continue;
      const second = terminatorAt(this.buffer, index + first);
      if (second === 0) continue;
      return { index, length: first + second };
    }
    return null;
  }
}

function parseBlock(block: string): SseEvent {
  const lines = block.split(/\r\n|\r|\n/u);
  const data: string[] = [];
  let name: string | undefined;

  for (const line of lines) {
    if (line.startsWith(':') || line.length === 0) continue;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'data') data.push(value);
    else if (field === 'event') name = value;
  }

  return { raw: block, lines, name, data: data.join('\n'), hasData: data.length > 0 };
}

/**
 * Render an event back to wire format, optionally replacing its data payload.
 *
 * Comments, `event:`, `id:` and `retry:` lines survive untouched and in order —
 * a proxy that reorders or drops them would break clients that depend on them.
 */
export function renderEvent(event: SseEvent, data: string | null): string {
  if (data === null) return `${event.raw}\n\n`;

  const replacement = data.split('\n').map((value) => `data: ${value}`);
  const out: string[] = [];
  let written = false;

  for (const line of event.lines) {
    const isData = line === 'data' || line.startsWith('data:');
    if (!isData) {
      out.push(line);
      continue;
    }
    if (!written) {
      out.push(...replacement);
      written = true;
    }
  }

  if (!written) out.push(...replacement);
  return `${out.join('\n')}\n\n`;
}

export interface SseRehydratorOptions {
  /** Paths whose strings arrive in fragments across events. */
  readonly deltaRules: readonly PathRule[];
  /** Resolve a complete token to its original value. */
  readonly resolve: TokenResolver;
}

interface DeltaStream {
  readonly rehydrator: StreamRehydrator;
  /** The last event this stream appeared in, used to shape a flush event. */
  template: { event: SseEvent; json: JsonValue; path: Path } | null;
}

export class SseRehydrator {
  private readonly parser = new SseParser();
  private readonly select: (path: Path) => boolean;
  private readonly resolve: TokenResolver;
  private readonly streams = new Map<string, DeltaStream>();

  constructor(options: SseRehydratorOptions) {
    this.select = selectByRules(options.deltaRules);
    this.resolve = options.resolve;
  }

  /** Feed raw stream text; returns rewritten SSE text ready to send on. */
  push(chunk: string): string {
    let out = '';
    for (const event of this.parser.push(chunk)) out += this.handle(event);
    return out;
  }

  /** End of stream: release every pending delta, then any unfinished event. */
  flush(): string {
    return this.flushStreams(() => true) + this.parser.flush();
  }

  private handle(event: SseEvent): string {
    if (!event.hasData) return renderEvent(event, null);

    // OpenAI's terminator is not JSON, so it is recognised before parsing.
    if (event.data.trim() === '[DONE]') {
      return this.flushStreams(() => true) + renderEvent(event, null);
    }

    let json: JsonValue;
    try {
      json = JSON.parse(event.data) as JsonValue;
    } catch {
      // Not JSON: substitute complete tokens and pass it through unchanged.
      return renderEvent(event, substituteComplete(event.data, this.resolve));
    }

    // A block or message that is ending cannot receive any more fragments, so
    // whatever is still held back for it has to go out first.
    const prefix = this.flushForStop(json);

    const rewritten = mapStrings(json, (text, path) => {
      if (!this.select(path)) return substituteComplete(text, this.resolve);
      return this.stream(keyFor(path, json), event, json, path).rehydrator.push(text);
    });

    return prefix + renderEvent(event, JSON.stringify(rewritten));
  }

  /** Get or create the state for one logical delta stream. */
  private stream(key: string, event: SseEvent, json: JsonValue, path: Path): DeltaStream {
    let state = this.streams.get(key);
    if (state === undefined) {
      state = { rehydrator: new StreamRehydrator(this.resolve), template: null };
      this.streams.set(key, state);
    }
    state.template = { event, json: structuredClone(json), path: [...path] };
    return state;
  }

  /**
   * Flush the streams a `*_stop` event closes: the one at its `index` when it
   * names one, all of them otherwise.
   */
  private flushForStop(json: JsonValue): string {
    if (typeof json !== 'object' || json === null || Array.isArray(json)) return '';

    const type = json['type'];
    if (typeof type !== 'string' || !type.endsWith('_stop')) return '';

    const index = json['index'];
    if (typeof index !== 'number') return this.flushStreams(() => true);
    return this.flushStreams((key) => key.endsWith(`#${index}`));
  }

  private flushStreams(matches: (key: string) => boolean): string {
    let out = '';

    // Deleting the current entry while iterating a Map is well defined.
    for (const [key, state] of this.streams) {
      if (!matches(key)) continue;
      this.streams.delete(key);

      const tail = state.rehydrator.flush();
      if (tail.length === 0 || state.template === null) continue;

      const { event, json, path } = state.template;
      const synthetic = mapStrings(json, (text, at) => {
        if (samePath(at, path)) return tail;
        // Other deltas in the template belong to other streams; emitting their
        // old text again would duplicate it.
        return this.select(at) ? '' : substituteComplete(text, this.resolve);
      });

      out += renderEvent(event, JSON.stringify(synthetic));
    }

    return out;
  }
}

/**
 * Identify the logical stream a delta belongs to.
 *
 * The path already separates choices and tool calls, because it carries their
 * array indices. Anthropic instead repeats `delta.text` for every content
 * block and distinguishes them with an `index` field, so that is appended.
 */
function keyFor(path: Path, json: JsonValue): string {
  const base = path.join('.');
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return base;
  const index = json['index'];
  return typeof index === 'number' ? `${base}#${index}` : base;
}

function samePath(a: Path, b: Path): boolean {
  return a.length === b.length && a.every((segment, index) => segment === b[index]);
}
