/**
 * Provider retention and training controls.
 *
 * Removing the personal data is one half of the answer; the other half is not
 * letting what remains be stored or trained on. Where a provider exposes that
 * as a request header or a body field, hushgate sets it on every request rather
 * than trusting each caller to remember. Where it is an account setting or a
 * contract clause, it cannot be set from here — so it is reported instead, and
 * `residency.requireDataControls` (implied by `block` mode) refuses to start
 * against an endpoint that offers nothing at all.
 */
import type { JsonValue } from '../redact/traverse.js';
import type { DataControl } from './registry.js';

export interface AppliedControls {
  /** Headers to merge into the outbound request. */
  readonly headers: Readonly<Record<string, string>>;
  /** The body, with any body-level controls set. */
  readonly body: JsonValue;
  /** One short description per control that was actually applied. */
  readonly applied: readonly string[];
  /** Controls that exist but cannot be set per request. */
  readonly manual: readonly string[];
}

/**
 * Apply every control that can be applied to one outbound request.
 *
 * A control the caller contradicted is overridden, deliberately: the point of a
 * policy layer is that a single caller cannot opt the organisation back into
 * retention by setting `store: true`.
 */
export function applyDataControls(
  controls: readonly DataControl[],
  body: JsonValue,
): AppliedControls {
  const headers: Record<string, string> = {};
  const applied: string[] = [];
  const manual: string[] = [];
  let next = body;

  for (const control of controls) {
    if (control.mechanism === 'header' && control.header !== undefined) {
      headers[control.header.name.toLowerCase()] = control.header.value;
      applied.push(`${control.kind} via header ${control.header.name}`);
      continue;
    }

    if (control.mechanism === 'body' && control.body !== undefined) {
      next = setPath(next, control.body.path, control.body.value);
      applied.push(`${control.kind} via body ${control.body.path}=${String(control.body.value)}`);
      continue;
    }

    manual.push(`${control.kind} (${control.mechanism})`);
  }

  return { headers, body: next, applied, manual };
}

/**
 * Set a dotted path on a JSON object, returning a copy.
 *
 * Intermediate objects are created as needed; a path that runs into a non-object
 * is left alone rather than clobbering whatever the caller meant by it.
 */
export function setPath(
  body: JsonValue,
  path: string,
  value: boolean | string | number,
): JsonValue {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return body;

  const segments = path.split('.');
  const copy = structuredClone(body) as Record<string, JsonValue>;
  let node: Record<string, JsonValue> = copy;

  for (const [index, segment] of segments.entries()) {
    if (index === segments.length - 1) {
      node[segment] = value;
      break;
    }

    const child = node[segment];
    if (child === undefined || child === null) {
      const created: Record<string, JsonValue> = {};
      node[segment] = created;
      node = created;
      continue;
    }

    if (typeof child !== 'object' || Array.isArray(child)) return copy;
    node = child as Record<string, JsonValue>;
  }

  return copy;
}
