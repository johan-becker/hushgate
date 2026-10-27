/**
 * Reporting a JSON syntax error without repeating what was being parsed.
 *
 * Shared by the proxy, which parses request bodies, and the audit trail reader,
 * which parses lines that are meant to be records but may be anything at all.
 */

/**
 * The offset a JSON syntax error reports, or `null` when it does not report one
 * in a shape we recognise.
 *
 * The parser's own message must never be repeated. V8 quotes the source it
 * choked on — `Unexpected token 'A', ..."essages": Anna Schmi"... is not valid
 * JSON` — so the message is a verbatim slice of whatever was being parsed: the
 * name, the IBAN, whatever a client failed to template, or whatever a
 * misconfigured logger appended to the audit trail. For a request body,
 * redaction has not run yet at that point, and the message does not only go
 * back to the caller who sent it, it goes to stderr, which an ops team ships to
 * a log aggregator that the GDPR treats as a processing system of its own. A
 * buggy client leaks a person into that pipeline by accident; anyone who wants
 * to plant PII fragments in someone else's logs does it on purpose. The same
 * holds for `hushgate audit verify`, whose output lands in CI logs and tickets.
 *
 * The offset is the one part of the message that helps whoever has to fix the
 * input and the one part that cannot spell a person's name, so it is the only
 * part kept. Its wording is V8's, not a contract, so a message that does not
 * match is dropped whole rather than guessed at.
 */
export function jsonErrorPosition(cause: unknown): number | null {
  if (!(cause instanceof Error)) return null;

  const match = /\bat position (\d+)/u.exec(cause.message);
  if (match === null) return null;

  const position = Number(match[1]);
  return Number.isSafeInteger(position) ? position : null;
}
