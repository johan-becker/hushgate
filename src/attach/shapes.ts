/**
 * Finding the attachments in a provider request body.
 *
 * The redaction layer selects string leaves by path rule, because it knows
 * exactly which leaves carry prose. Attachments cannot be found that way: what
 * identifies one is the *shape* of the object holding it, not where it sits,
 * and the same shape appears at several depths — a document block inside a
 * message, and again inside a `tool_result` that quotes one back.
 *
 * So this module matches by shape, anywhere in the body, for both providers at
 * once rather than per route. That is deliberate. Recognising something that
 * turns out not to be an attachment costs a refused request the operator can
 * see; failing to recognise one costs an unredacted document sent to a third
 * country, which is the failure the whole product exists to prevent. When the
 * providers add a content-part type next quarter, the shape matcher will
 * usually already see it.
 */
import { parseDataUrl } from './decode.js';
import type { Attachment, UnresolvableAttachment } from './types.js';

/** Where the walk is allowed to look. Everything else is configuration. */
const CONTENT_ROOTS = new Set(['messages', 'system', 'input', 'prompt']);

/** Deeper than this is not a conversation; it is someone probing the parser. */
const MAX_DEPTH = 24;

export interface AttachmentSite {
  readonly path: readonly (string | number)[];
  /** Base64 payload, when the attachment travelled inline. */
  readonly data: string | null;
  readonly declaredMediaType: string | null;
  readonly filename: string | null;
  /** Set when the attachment is a reference hushgate cannot resolve. */
  readonly unresolvable: string | null;
}

type Json = unknown;

const asObject = (value: Json): Record<string, Json> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : null;

const asString = (value: Json): string | null => (typeof value === 'string' ? value : null);

/**
 * Collect every attachment-shaped object in `body`.
 *
 * Paths are returned in traversal order and are stable for the body that was
 * walked, which is what lets `rewrite` put a text part back in the same place.
 */
export function findAttachmentSites(body: Json): AttachmentSite[] {
  const sites: AttachmentSite[] = [];

  const walk = (node: Json, path: (string | number)[], depth: number): void => {
    if (depth > MAX_DEPTH) return;

    if (Array.isArray(node)) {
      for (const [index, item] of node.entries()) {
        path.push(index);
        walk(item, path, depth + 1);
        path.pop();
      }
      return;
    }

    const object = asObject(node);
    if (object === null) return;

    const site = matchSite(object, path);
    if (site !== null) {
      sites.push(site);
      // An attachment is a leaf as far as this walk is concerned. Descending
      // into it would re-match the `source` object on its own.
      return;
    }

    for (const [key, value] of Object.entries(object)) {
      // At the top level, only the keys that carry a conversation are walked.
      // `tools`, `metadata` and the several dozen tuning knobs cannot hold a
      // document, and walking them is attack surface for no gain.
      if (depth === 0 && !CONTENT_ROOTS.has(key)) continue;
      path.push(key);
      walk(value, path, depth + 1);
      path.pop();
    }
  };

  walk(body, [], 0);
  return sites;
}

/** Recognise one content part. Returns `null` when it is not an attachment. */
function matchSite(part: Record<string, Json>, path: readonly (string | number)[]): AttachmentSite | null {
  const type = asString(part['type']);
  if (type === null) return null;

  if (type === 'document' || type === 'image') return anthropicSource(part, path, type);
  if (type === 'file' || type === 'input_file') return openaiFile(part, path);
  if (type === 'image_url') return openaiImageUrl(part, path);
  if (type === 'input_audio') return openaiAudio(part, path);

  return null;
}

/**
 * Anthropic `document` and `image` blocks.
 *
 * `source.type` is the discriminator: `base64` and `text` travel inline, while
 * `url` and `file` are references to something hushgate would have to fetch.
 * It does not fetch: making an outbound request of its own would break the
 * claim the README makes about network behaviour, and it would mean hushgate
 * pulling an unknown document into memory on a caller's say-so.
 */
function anthropicSource(
  part: Record<string, Json>,
  path: readonly (string | number)[],
  blockType: string,
): AttachmentSite | null {
  const source = asObject(part['source']);
  if (source === null) return null;

  const sourceType = asString(source['type']);
  const mediaType = asString(source['media_type']);
  const filename = asString(part['title']) ?? asString(part['filename']);
  const base = { path: [...path], declaredMediaType: mediaType, filename };

  if (sourceType === 'base64') {
    const data = asString(source['data']);
    if (data === null) return null;
    return { ...base, data, unresolvable: null };
  }

  if (sourceType === 'text') {
    // Already text, but it still has to go through extraction and redaction:
    // it is a document the caller attached, not prose they typed.
    const data = asString(source['data']);
    if (data === null) return null;
    return {
      ...base,
      data: Buffer.from(data, 'utf8').toString('base64'),
      declaredMediaType: mediaType ?? 'text/plain',
      unresolvable: null,
    };
  }

  if (sourceType === 'url') {
    return { ...base, data: null, unresolvable: `${blockType} is a remote URL, which hushgate will not fetch` };
  }

  if (sourceType === 'file') {
    return {
      ...base,
      data: null,
      unresolvable: `${blockType} is a provider file id, which only the provider can read`,
    };
  }

  return null;
}

/**
 * OpenAI `file` parts, and the `input_file` spelling the Responses API uses.
 *
 * `file_data` is a data URL in practice, but bare base64 is also seen in the
 * wild, so both are accepted.
 */
function openaiFile(part: Record<string, Json>, path: readonly (string | number)[]): AttachmentSite | null {
  const file = asObject(part['file']) ?? part;
  const filename = asString(file['filename']);
  const fileData = asString(file['file_data']);

  if (fileData !== null) {
    const url = parseDataUrl(fileData);
    if (url !== null) {
      if (!url.base64) {
        return {
          path: [...path],
          data: Buffer.from(decodeURIComponent(url.payload), 'utf8').toString('base64'),
          declaredMediaType: url.mediaType,
          filename,
          unresolvable: null,
        };
      }
      return { path: [...path], data: url.payload, declaredMediaType: url.mediaType, filename, unresolvable: null };
    }
    return { path: [...path], data: fileData, declaredMediaType: null, filename, unresolvable: null };
  }

  if (asString(file['file_id']) !== null) {
    return {
      path: [...path],
      data: null,
      declaredMediaType: null,
      filename,
      unresolvable: 'file is a provider file id, which only the provider can read',
    };
  }

  return null;
}

/** OpenAI `image_url` parts: a data URL inline, or a link hushgate will not follow. */
function openaiImageUrl(part: Record<string, Json>, path: readonly (string | number)[]): AttachmentSite | null {
  const holder = asObject(part['image_url']);
  const url = asString(holder === null ? part['image_url'] : holder['url']);
  if (url === null) return null;

  const parsed = parseDataUrl(url);
  if (parsed === null) {
    return {
      path: [...path],
      data: null,
      declaredMediaType: null,
      filename: null,
      unresolvable: 'image is a remote URL, which hushgate will not fetch',
    };
  }

  return {
    path: [...path],
    data: parsed.base64 ? parsed.payload : Buffer.from(parsed.payload, 'utf8').toString('base64'),
    declaredMediaType: parsed.mediaType,
    filename: null,
    unresolvable: null,
  };
}

/** OpenAI `input_audio`. hushgate has no speech recognition, so this is a refusal. */
function openaiAudio(part: Record<string, Json>, path: readonly (string | number)[]): AttachmentSite | null {
  const audio = asObject(part['input_audio']);
  if (audio === null) return null;
  return {
    path: [...path],
    data: null,
    declaredMediaType: 'audio/*',
    filename: null,
    unresolvable: 'audio cannot be transcribed by hushgate, so its contents cannot be pseudonymised',
  };
}

/** Narrowing helper for callers that only want the resolvable sites. */
export function isInline(site: AttachmentSite): site is AttachmentSite & { data: string } {
  return site.data !== null;
}

export type { Attachment, UnresolvableAttachment };
