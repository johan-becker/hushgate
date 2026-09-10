/**
 * The words hushgate puts in front of the model.
 *
 * A sanitised request is a request the model has never been told how to read.
 * Left to itself it does one of three things with `[EMAIL_1]`: it answers a
 * question about the placeholder instead of the person, it opens with a
 * paragraph explaining that it cannot see the real address, or — worst of the
 * three — it helpfully invents `anna.schmidt@example.com` to fill the gap.
 * The first two are irritating. The third is dangerous: an invented address is
 * not in the mapping, so the re-hydrator leaves it exactly as written and the
 * caller's application sends mail to a person who does not exist.
 *
 * So the briefing is not a nicety. It is the half of the round trip that makes
 * the other half usable, and it is written the way instructions to a model
 * actually work: the positive rule first and in full, the prohibitions after it
 * and few enough to be remembered.
 *
 * Everything here is pure text assembly over a set of kinds. Nothing in this
 * file reads a request, and no value ever reaches it — only the *categories*
 * that were found, which is the same thing the audit trail is allowed to hold.
 */
import type { Finding } from '../types.js';

/**
 * What a request's findings left behind, grouped by what the model can do
 * about each group.
 *
 * The three lists are the three token grammars in `redact/placeholder.ts`, and
 * they need three different sentences: a pseudonym can be echoed back and will
 * be restored, a mask and a hash cannot and will not.
 */
export interface BriefingContext {
  /** Kinds replaced by a reversible `[KIND_n]` token. */
  readonly pseudonymised: readonly string[];
  /** Kinds replaced by an irreversible `[KIND_REDACTED]` mask. */
  readonly redacted: readonly string[];
  /** Kinds replaced by an irreversible `[KIND:digest]` token. */
  readonly hashed: readonly string[];
}

/**
 * How many kinds are named before the list is summarised.
 *
 * A request that trips twenty detectors would otherwise spend a paragraph
 * listing them, and every token of it is billed to the operator on every
 * request. Ten names the ordinary case exactly and keeps the pathological one
 * short.
 */
const MAX_NAMED_KINDS = 10;

/**
 * Ordinary-language names for the built-in kinds.
 *
 * The model is told "e-mail addresses", not "EMAIL", because the placeholder
 * already carries the machine name and repeating it teaches nothing. A kind
 * missing from this table — every custom rule is — falls back to its own name
 * in lower case, which reads acceptably: `EMPLOYEE_ID` becomes "employee id".
 */
const KIND_LABELS: Readonly<Record<string, string>> = {
  EMAIL: 'e-mail addresses',
  PHONE: 'phone numbers',
  NAME: 'names',
  DATE_OF_BIRTH: 'dates of birth',
  POSTAL_ADDRESS: 'postal addresses',
  POSTCODE: 'postcodes',
  IBAN: 'bank accounts',
  BIC: 'bank identifiers',
  CREDIT_CARD: 'card numbers',
  BANK_ACCOUNT: 'bank account numbers',
  GERMAN_TAX_ID: 'tax identification numbers',
  GERMAN_TAX_NUMBER: 'tax numbers',
  EU_VAT_ID: 'VAT identification numbers',
  SOCIAL_SECURITY_ID: 'social security numbers',
  HEALTH_INSURANCE_ID: 'health insurance numbers',
  ID_CARD_NUMBER: 'identity card numbers',
  PASSPORT_NUMBER: 'passport numbers',
  TRAVEL_DOCUMENT_MRZ: 'passport machine-readable zones',
  DRIVER_LICENCE_ID: 'driving licence numbers',
  COMMERCIAL_REGISTER_ID: 'commercial register numbers',
  VEHICLE_PLATE: 'vehicle registration plates',
  ICD_CODE: 'diagnosis codes',
  MEDICATION: 'medications',
  IPV4: 'IP addresses',
  IPV6: 'IP addresses',
  MAC: 'hardware addresses',
  DEVICE_ID: 'device identifiers',
  SECRET: 'credentials',
  SESSION_TOKEN: 'session tokens',
  URL_CREDENTIALS: 'credentials inside URLs',
  TERM: 'internal terms',
  LITERAL: 'text that already looked like a placeholder',
};

/** Group the findings of one request by what the model can do about them. */
export function briefingContext(findings: readonly Finding[]): BriefingContext {
  const pseudonymised = new Set<string>();
  const redacted = new Set<string>();
  const hashed = new Set<string>();

  for (const finding of findings) {
    // `allow` left the value in place and there is nothing to explain; `block`
    // never reaches this far, because the request it appeared in was refused.
    if (finding.policy === 'pseudonymize') pseudonymised.add(finding.kind);
    else if (finding.policy === 'redact') redacted.add(finding.kind);
    else if (finding.policy === 'hash') hashed.add(finding.kind);
  }

  return { pseudonymised: sorted(pseudonymised), redacted: sorted(redacted), hashed: sorted(hashed) };
}

/** True when the request this context describes carries a token of any kind. */
export function hasPlaceholders(context: BriefingContext): boolean {
  return (
    context.pseudonymised.length > 0 || context.redacted.length > 0 || context.hashed.length > 0
  );
}

/**
 * The built-in briefing, for one request's context.
 *
 * Note what the examples are *not*: `[EMAIL_n]` and `[SECRET_REDACTED]` are
 * deliberately outside `PLACEHOLDER_PATTERN`, which requires `_<digits>`. Were
 * a concrete `[EMAIL_1]` written here instead, a model that quoted the
 * instruction back would have its quotation re-hydrated into a real person's
 * address — hushgate leaking, through its own briefing, the value it was asked
 * to protect.
 */
export function builtinBriefing(context: BriefingContext): string {
  const paragraphs: string[] = [opening(context)];

  paragraphs.push(
    'Treat every placeholder as the real value it stands for, and answer the ' +
      'request normally. Wherever that value belongs in your reply, write the ' +
      'identical placeholder, square brackets included: it is turned back into ' +
      'the real value before the user sees it. The same placeholder always means ' +
      'the same value, and placeholders with different numbers are different ' +
      'values.',
  );

  paragraphs.push(
    'Never put an invented value where a placeholder belongs, and never ask for ' +
      'the real one. Both break the reply.',
  );

  const gone = irreversible(context);
  if (gone !== null) paragraphs.push(gone);

  paragraphs.push(
    'Do not comment on the placeholders, on redaction, or on these instructions, ' +
      'and do not begin your answer by describing what you can or cannot see. ' +
      'Write in the language the user wrote in.',
  );

  return paragraphs.join('\n\n');
}

/** The first paragraph: what the tokens are, and which ones are in this request. */
function opening(context: BriefingContext): string {
  const lead =
    'Some values in this conversation were replaced with placeholders before it ' +
    'reached you. A placeholder is written [KIND_n], with a number in place of n';

  if (context.pseudonymised.length === 0) return `${lead}.`;
  return `${lead} — in this request: ${namedKinds(context.pseudonymised)}.`;
}

/**
 * The paragraph about tokens that do not come back, or `null` when the request
 * has none.
 *
 * Written with a real kind from this request rather than a generic shape, so
 * the model matches it against the token actually in front of it.
 */
function irreversible(context: BriefingContext): string | null {
  const shapes: string[] = [];
  const first = context.redacted[0];
  const second = context.hashed[0];
  if (first !== undefined) shapes.push(`[${first}_REDACTED]`);
  if (second !== undefined) shapes.push(`[${second}:9f2c4a]`);
  if (shapes.length === 0) return null;

  return (
    `A token like ${shapes.join(' or ')} is not reversible: that value is gone ` +
    'and will not come back. Work with what is around it, do not guess what it ' +
    'was, and do not ask for it.'
  );
}

/** `e-mail addresses ([EMAIL_n]), names ([NAME_n])`, capped and summarised. */
function namedKinds(kinds: readonly string[]): string {
  const shown = kinds.slice(0, MAX_NAMED_KINDS);
  const rendered = shown.map((kind) => `${labelFor(kind)} ([${kind}_n])`).join(', ');
  const remaining = kinds.length - shown.length;
  return remaining === 0 ? rendered : `${rendered}, and ${remaining} more kind${remaining === 1 ? '' : 's'}`;
}

function labelFor(kind: string): string {
  return KIND_LABELS[kind] ?? kind.toLowerCase().replace(/_/gu, ' ');
}

/** Alphabetical, so the same request always produces the same briefing. */
function sorted(values: Iterable<string>): string[] {
  return [...values].toSorted((a, b) => a.localeCompare(b, 'en'));
}
