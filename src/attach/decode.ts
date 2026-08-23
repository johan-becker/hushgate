/**
 * Getting bytes out of a request body without letting the body decide how much
 * memory hushgate spends.
 *
 * Every value here arrives base64-encoded inside JSON that has already been
 * parsed, so the string is resident before this module sees it. What this
 * module refuses to do is *double* that cost for an attachment the caller was
 * never allowed to send: the decoded size is computed from the encoded length
 * and checked before a single byte is allocated.
 */

/** A `data:` URL, split into the parts hushgate cares about. */
export interface DataUrl {
  readonly mediaType: string | null;
  readonly base64: boolean;
  readonly payload: string;
}

/**
 * Parse `data:[<media type>][;base64],<payload>`.
 *
 * Returns `null` for anything that is not a data URL, which is how a caller
 * distinguishes "this is a remote reference we must refuse" from "this is an
 * inline attachment we can read".
 */
export function parseDataUrl(value: string): DataUrl | null {
  if (!value.startsWith('data:')) return null;

  const comma = value.indexOf(',');
  if (comma === -1) return null;

  const meta = value.slice('data:'.length, comma);
  const payload = value.slice(comma + 1);
  const parts = meta.split(';');
  const base64 = parts.some((part) => part.trim().toLowerCase() === 'base64');
  const declared = parts[0]?.trim().toLowerCase() ?? '';

  return {
    mediaType: declared === '' ? null : declared,
    base64,
    payload,
  };
}

/**
 * Bytes a base64 string will decode to, without decoding it.
 *
 * Four encoded characters carry three bytes; the padding at the end carries
 * fewer. Whitespace is legal inside base64 in most producers' output, so it is
 * discounted — an over-estimate here would reject a legitimate attachment, and
 * an under-estimate would let an oversized one through, so it is counted
 * exactly rather than approximated.
 */
export function base64DecodedLength(value: string): number {
  let significant = 0;
  let padding = 0;

  for (const char of value) {
    if (char === '\n' || char === '\r' || char === ' ' || char === '\t') continue;
    if (char === '=') {
      padding += 1;
      continue;
    }
    // Padding is only padding at the end. A '=' followed by more data means
    // the string is malformed, and Buffer will stop there anyway.
    if (padding > 0) return -1;
    significant += 1;
  }

  if (padding > 2) return -1;
  return Math.floor((significant * 3) / 4);
}

export type DecodeResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: string; readonly oversize: boolean };

/**
 * Decode base64 to bytes, refusing anything over `maxBytes` before allocating.
 *
 * `Buffer.from(value, 'base64')` is famously lenient: it ignores characters
 * outside the alphabet rather than failing, so a corrupted payload silently
 * yields short output. The round-trip length check below is what turns that
 * into an honest error.
 */
export function decodeBase64(value: string, maxBytes: number): DecodeResult {
  const expected = base64DecodedLength(value);
  if (expected < 0) return { ok: false, reason: 'attachment data is not valid base64', oversize: false };
  if (expected === 0) return { ok: false, reason: 'attachment data is empty', oversize: false };
  if (expected > maxBytes) {
    return {
      ok: false,
      reason: `attachment is ${formatBytes(expected)}, over the ${formatBytes(maxBytes)} limit`,
      oversize: true,
    };
  }

  const buffer = Buffer.from(value, 'base64');
  if (buffer.byteLength !== expected) {
    return { ok: false, reason: 'attachment data is not valid base64', oversize: false };
  }

  return { ok: true, bytes: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) };
}

/** Sizes as an operator would write them, for error messages and nothing else. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
