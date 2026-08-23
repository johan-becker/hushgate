/**
 * Just enough ZIP to open an office document, and no more.
 *
 * OOXML and ODF are ZIP containers, so reading one means reading ZIP — but a
 * general-purpose unzip is the wrong instrument here. It inflates everything it
 * finds, it believes what the archive says about its own sizes, and so a 21 KB
 * file crafted for the purpose answers with hundreds of megabytes of resident
 * memory. Both defaults are inverted below: the caller states which entries it
 * wants before a single byte is inflated, and every allocation is bounded by a
 * limit the caller set rather than by a number an attacker wrote into the file.
 *
 * Nothing here touches the filesystem, so the path traversal that dominates
 * ordinary ZIP hardening (`../../etc/cron.d/x`) is simply not reachable: an
 * entry name is a lookup key and never a destination.
 */
import { inflateRawSync } from 'node:zlib';
import { HushgateError } from '../errors.js';

/** One inflated member of the archive. */
export interface ZipEntry {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** The budget a container has to stay inside. Every field is a hard refusal. */
export interface ZipLimits {
  /** Entries the central directory may declare before the file is refused. */
  readonly maxEntries: number;
  /** Bytes any one entry may inflate to. */
  readonly maxEntryBytes: number;
  /** Bytes all selected entries may inflate to together. */
  readonly maxTotalBytes: number;
  /** Inflated bytes per compressed byte. The bomb signature. */
  readonly maxRatio: number;
}

/**
 * A container hushgate will not read further.
 *
 * Thrown rather than returned because the ZIP layer has no opinion about what
 * should happen next; the extractor above it turns this into the `ok: false`
 * that the attachment contract requires. Messages are written as operator-facing
 * fragments so they can be used as a `reason` verbatim.
 */
export class ZipError extends HushgateError {}

const DEFAULT_LIMITS: ZipLimits = {
  maxEntries: 2048,
  maxEntryBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxRatio: 200,
};

/**
 * Below this size the ratio means nothing: 40 bytes of deflate stream yielding
 * 12 KB of XML boilerplate is an ordinary empty document, not an attack. An
 * entry this small cannot exhaust anything, and `maxTotalBytes` still counts it.
 */
const RATIO_FLOOR_BYTES = 64 * 1024;

const EOCD_SIGNATURE = 0x0605_4b50;
const ZIP64_LOCATOR_SIGNATURE = 0x0706_4b50;
const ZIP64_EOCD_SIGNATURE = 0x0606_4b50;
const CENTRAL_SIGNATURE = 0x0201_4b50;
const LOCAL_SIGNATURE = 0x0403_4b50;
const ZIP64_EXTRA_ID = 0x0001;

const EOCD_LENGTH = 22;
const CENTRAL_LENGTH = 46;
const LOCAL_LENGTH = 30;

/** A 32-bit field set to all ones means "the real value is in the zip64 extra". */
const SENTINEL_32 = 0xffff_ffff;
const SENTINEL_16 = 0xffff;

/** Bit 0 is PKWARE encryption, bit 6 strong encryption. Neither is readable. */
const ENCRYPTED_FLAGS = 0x0001 | 0x0040;

const readU64 = (view: DataView, at: number): number => {
  const value = view.getBigUint64(at, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ZipError('zip declares a size larger than this reader can represent');
  }
  return Number(value);
};

/** The `code` of a thrown value, without asserting anything about its shape. */
const errorCode = (cause: unknown): string => {
  if (typeof cause !== 'object' || cause === null) return '';
  const code: unknown = Reflect.get(cause, 'code');
  return typeof code === 'string' ? code : '';
};

/**
 * Find the End Of Central Directory record.
 *
 * It is not at a fixed offset because the archive comment follows it, so the
 * tail is scanned backwards. The comment length is what disambiguates: a record
 * whose declared comment does not end exactly at the end of the file is a byte
 * pattern inside some entry's compressed data, not the record we want.
 */
const findEocd = (view: DataView, length: number): number => {
  if (length < EOCD_LENGTH) throw new ZipError('file is too small to be a zip container');

  const earliest = Math.max(0, length - (SENTINEL_16 + EOCD_LENGTH));
  for (let at = length - EOCD_LENGTH; at >= earliest; at -= 1) {
    if (view.getUint32(at, true) !== EOCD_SIGNATURE) continue;
    if (at + EOCD_LENGTH + view.getUint16(at + 20, true) === length) return at;
  }

  throw new ZipError('zip end of central directory record was not found');
};

interface Directory {
  readonly offset: number;
  readonly size: number;
  readonly entries: number;
}

/** Where the central directory is and how many entries it holds, zip64 included. */
const readDirectory = (view: DataView, length: number, eocd: number): Directory => {
  let entries = view.getUint16(eocd + 10, true);
  let size = view.getUint32(eocd + 12, true);
  let offset = view.getUint32(eocd + 16, true);

  if (entries === SENTINEL_16 || size === SENTINEL_32 || offset === SENTINEL_32) {
    const locator = eocd - 20;
    if (locator < 0 || view.getUint32(locator, true) !== ZIP64_LOCATOR_SIGNATURE) {
      throw new ZipError('zip uses zip64 offsets but carries no zip64 locator');
    }

    const record = readU64(view, locator + 8);
    if (record + 56 > length || view.getUint32(record, true) !== ZIP64_EOCD_SIGNATURE) {
      throw new ZipError('zip64 end of central directory record is missing or truncated');
    }

    entries = readU64(view, record + 32);
    size = readU64(view, record + 40);
    offset = readU64(view, record + 48);
  }

  if (offset + size > length) throw new ZipError('zip central directory is truncated');
  return { offset, size, entries };
};

interface Zip64Sizes {
  readonly uncompressed: number | null;
  readonly compressed: number | null;
  readonly local: number | null;
}

/**
 * Read the values a zip64 extra field holds in place of the 32-bit ones.
 *
 * Only the fields whose fixed slot held the sentinel are present, and the
 * order — uncompressed, compressed, local header offset — is fixed by the
 * specification rather than tagged, so a wrong guess here reads the next field
 * as this one. That is precisely the "silently returns garbage" outcome, so a
 * field that is asked for and not there is an error.
 */
const readZip64Sizes = (
  view: DataView,
  extraAt: number,
  extraLength: number,
  needed: { readonly uncompressed: boolean; readonly compressed: boolean; readonly local: boolean },
): Zip64Sizes => {
  const stop = extraAt + extraLength;

  for (let cursor = extraAt; cursor + 4 <= stop; ) {
    const id = view.getUint16(cursor, true);
    const size = view.getUint16(cursor + 2, true);
    const body = cursor + 4;
    if (body + size > stop) break;

    if (id === ZIP64_EXTRA_ID) {
      let field = body;
      const take = (): number => {
        if (field + 8 > body + size) {
          throw new ZipError('zip64 extra field is too short for the sizes it must carry');
        }
        const value = readU64(view, field);
        field += 8;
        return value;
      };

      const uncompressed = needed.uncompressed ? take() : null;
      const compressed = needed.compressed ? take() : null;
      const local = needed.local ? take() : null;
      return { uncompressed, compressed, local };
    }

    cursor = body + size;
  }

  throw new ZipError('zip entry uses zip64 sizes but carries no zip64 extra field');
};

/**
 * Where an entry's compressed bytes start.
 *
 * The central directory is authoritative about *sizes* — a local header may
 * carry zeros when the data descriptor bit is set, which is exactly the lie
 * that makes local-header parsing unsafe — but only the local header knows how
 * long its own name and extra field are, and therefore where the data begins.
 */
const localDataOffset = (
  view: DataView,
  length: number,
  local: number,
  compressed: number,
): number => {
  if (local + LOCAL_LENGTH > length) throw new ZipError('zip local header is past the end of the file');
  if (view.getUint32(local, true) !== LOCAL_SIGNATURE) {
    throw new ZipError('zip local header has a bad signature');
  }

  const at = local + LOCAL_LENGTH + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
  if (at + compressed > length) throw new ZipError('zip entry data is truncated');
  return at;
};

const inflate = (source: Uint8Array, allowance: number): Uint8Array => {
  try {
    // maxOutputLength aborts the inflate mid-stream. Checking a length after
    // the fact is no defence at all: by then the memory has been committed,
    // which is the whole trick a decompression bomb turns on.
    return new Uint8Array(inflateRawSync(source, { maxOutputLength: Math.max(allowance, 1) }));
  } catch (cause) {
    if (errorCode(cause) === 'ERR_BUFFER_TOO_LARGE') {
      throw new ZipError(`a zip entry inflates past the ${allowance} byte limit`, { cause });
    }
    throw new ZipError('zip entry data is not a readable deflate stream', { cause });
  }
};

/**
 * Inflate the entries `names` accepts, and refuse the archive otherwise.
 *
 * The predicate runs against every name in the central directory before any
 * decompression happens: an OOXML extractor wants a handful of the parts, and
 * the rest are both wasted work and attack surface nobody asked for.
 */
export function readZip(
  bytes: Uint8Array,
  names: (name: string) => boolean,
  limits: Partial<ZipLimits> = {},
): ZipEntry[] {
  const budget: ZipLimits = { ...DEFAULT_LIMITS, ...limits };
  const length = bytes.byteLength;
  const view = new DataView(bytes.buffer, bytes.byteOffset, length);

  const directory = readDirectory(view, length, findEocd(view, length));
  if (directory.entries > budget.maxEntries) {
    throw new ZipError(`zip declares more than ${budget.maxEntries} entries`);
  }

  const decoder = new TextDecoder();
  const end = directory.offset + directory.size;
  const found: ZipEntry[] = [];
  let at = directory.offset;
  let total = 0;

  for (let index = 0; index < directory.entries; index += 1) {
    if (at + CENTRAL_LENGTH > end) throw new ZipError('zip central directory is truncated');
    if (view.getUint32(at, true) !== CENTRAL_SIGNATURE) {
      throw new ZipError('zip central directory entry has a bad signature');
    }

    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    let compressed = view.getUint32(at + 20, true);
    let uncompressed = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    let local = view.getUint32(at + 42, true);

    const nameAt = at + CENTRAL_LENGTH;
    const extraAt = nameAt + nameLength;
    const next = extraAt + extraLength + commentLength;
    if (next > end) throw new ZipError('zip central directory is truncated');

    const name = decoder.decode(bytes.subarray(nameAt, extraAt));
    at = next;

    if (compressed === SENTINEL_32 || uncompressed === SENTINEL_32 || local === SENTINEL_32) {
      const wide = readZip64Sizes(view, extraAt, extraLength, {
        uncompressed: uncompressed === SENTINEL_32,
        compressed: compressed === SENTINEL_32,
        local: local === SENTINEL_32,
      });
      uncompressed = wide.uncompressed ?? uncompressed;
      compressed = wide.compressed ?? compressed;
      local = wide.local ?? local;
    }

    if (!names(name)) continue;
    if ((flags & ENCRYPTED_FLAGS) !== 0) throw new ZipError('zip entry is encrypted');

    // Store and deflate cover every office document there is. Another method is
    // skipped rather than fatal: a container may hold one exotic part beside
    // the parts that actually carry text.
    if (method !== 0 && method !== 8) continue;

    // Entry names stay out of these messages. A reason reaches the audit trail,
    // and a filename inside a container can be personal data just as the
    // attachment's own filename can.
    if (uncompressed > budget.maxEntryBytes) {
      throw new ZipError(
        `a zip entry declares ${uncompressed} bytes of output, over the ${budget.maxEntryBytes} byte limit`,
      );
    }
    if (total + uncompressed > budget.maxTotalBytes) {
      throw new ZipError(`zip entries expand to more than ${budget.maxTotalBytes} bytes in total`);
    }

    const dataAt = localDataOffset(view, length, local, compressed);
    const source = bytes.subarray(dataAt, dataAt + compressed);
    const allowance = Math.min(budget.maxEntryBytes, budget.maxTotalBytes - total);

    if (method === 0 && source.length > allowance) {
      throw new ZipError(`a stored zip entry is larger than the ${allowance} byte limit`);
    }
    const inflated = method === 0 ? source.slice() : inflate(source, allowance);

    // Re-checked after the fact as well as before, so that the limits still
    // hold if maxOutputLength ever stops being honoured by the runtime.
    if (inflated.length > budget.maxEntryBytes || total + inflated.length > budget.maxTotalBytes) {
      throw new ZipError('a zip entry inflated past the size limits');
    }
    if (inflated.length > RATIO_FLOOR_BYTES && compressed > 0) {
      const ratio = inflated.length / compressed;
      if (ratio > budget.maxRatio) {
        throw new ZipError(
          `a zip entry expands ${Math.round(ratio)} times, over the ratio limit of ${budget.maxRatio}`,
        );
      }
    }

    total += inflated.length;
    found.push({ name, bytes: inflated });
  }

  return found;
}
