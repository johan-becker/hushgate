/**
 * The library, without the proxy: what a redaction session does to one string.
 *
 *     node examples/redact.mjs
 *
 * The input deliberately contains a literal "[EMAIL_1]" that the caller typed
 * themselves. hushgate escapes it as a LITERAL, so the real address gets
 * [EMAIL_2] and the caller's text comes back exactly as it went in.
 */
import { Session } from '../dist/index.js';

const session = new Session({
  policies: { GERMAN_TAX_ID: 'hash', IPV4: 'allow' },
  hmacKey: 'a fixed key, so hashes are stable across restarts',
  dictionary: { names: ['Anna Schmidt'] },
});

const input =
  'Anna Schmidt <anna.schmidt@nordlicht.example> — the template still says [EMAIL_1]. ' +
  'Steuer-ID 86095742719, host 10.14.2.7.';

const { text, findings } = session.redact(input);

console.log('upstream sees :', text);
console.log('findings      :', findings.map((f) => `${f.kind}=${f.policy}`).join(' '));
console.log('restored      :', session.restore(text));
