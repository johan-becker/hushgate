import { describe, expect, it } from 'vitest';
import { creditCardDetector } from '../src/detectors/creditcard.js';
import {
  DEVICE_ID_PRIORITY,
  imeiDetector,
  isRfcUuid,
  isValidImei,
  labelledUuidDetector,
  uuidDetector,
} from '../src/detectors/deviceid.js';
import { detect } from '../src/detectors/index.js';
import { macDetector } from '../src/detectors/network.js';
import {
  createSessionTokenDetector,
  SESSION_COOKIE_NAMES,
  SESSION_TOKEN_PRIORITY,
  sessionTokenDetector,
} from '../src/detectors/sessiontoken.js';
import type { Detector, Span } from '../src/types.js';

const values = (text: string, detector: Detector): string[] =>
  detector.find(text).map((s) => s.value);

const kinds = (spans: readonly Span[]): string[] => spans.map((s) => s.kind);

/** The load-bearing invariant: every span still slices back to itself. */
const assertSliceable = (text: string, spans: readonly Span[]): void => {
  for (const span of spans) expect(span.value).toBe(text.slice(span.start, span.end));
};

describe('IMEI', () => {
  it.each([
    '490154203237518',
    '49-015420-323751-8',
    '49 015420 323751 8',
  ])('accepts %s', (imei) => {
    expect(values(`Gerät ${imei} gesperrt`, imeiDetector)).toEqual([imei]);
  });

  it('accepts an IMEI behind its label', () => {
    const text = 'IMEI: 490154203237518';
    const spans = imeiDetector.find(text);
    expect(values(text, imeiDetector)).toEqual(['490154203237518']);
    expect(kinds(spans)).toEqual(['DEVICE_ID']);
    assertSliceable(text, spans);
  });

  it('rejects fourteen digits', () => {
    expect(isValidImei('49015420323751')).toBe(false);
    expect(imeiDetector.find('IMEI: 49015420323751')).toEqual([]);
  });

  it('rejects a fifteen-digit run whose check digit is wrong', () => {
    expect(isValidImei('490154203237517')).toBe(false);
    expect(imeiDetector.find('Auftrag 490154203237517 offen')).toEqual([]);
  });

  it('rejects a sixteenth digit, even one sitting behind a separator', () => {
    expect(imeiDetector.find('4901542032375181')).toEqual([]);
    expect(imeiDetector.find('49 015420 323751 81')).toEqual([]);
  });

  it('does not start inside a longer word', () => {
    expect(imeiDetector.find('X490154203237518')).toEqual([]);
    expect(imeiDetector.find('490154203237518X')).toEqual([]);
  });
});

describe('IMEI and CREDIT_CARD never claim the same characters', () => {
  it('leaves a fifteen-digit Amex to the card detector', () => {
    // 378282246310005 passes Luhn and is a real issuer prefix at length 15.
    expect(isValidImei('378282246310005')).toBe(true);
    expect(imeiDetector.find('Karte 378282246310005 gesperrt')).toEqual([]);
    expect(values('Karte 378282246310005 gesperrt', creditCardDetector)).toEqual([
      '378282246310005',
    ]);
  });

  it('produces exactly one finding when both detectors run', () => {
    const text = 'Karte 378282246310005 und Gerät 490154203237518.';
    const spans = detect(text, [creditCardDetector, imeiDetector]);
    expect(kinds(spans)).toEqual(['CREDIT_CARD', 'DEVICE_ID']);
    assertSliceable(text, spans);
  });

  it('ranks a device id below a card, so the card wins any future tie', () => {
    expect(DEVICE_ID_PRIORITY).toBeLessThan(creditCardDetector.priority);
  });
});

describe('UUID', () => {
  it.each([
    '550e8400-e29b-41d4-a716-446655440000',
    'A1B2C3D4-E5F6-7890-ABCD-EF1234567890',
  ])('accepts %s unaided', (uuid) => {
    expect(isRfcUuid(uuid)).toBe(true);
    expect(values(`id ${uuid} ok`, uuidDetector)).toEqual([uuid]);
  });

  it('reports a UUID as a device id', () => {
    const text = 'Installation 550e8400-e29b-41d4-a716-446655440000';
    const spans = uuidDetector.find(text);
    expect(kinds(spans)).toEqual(['DEVICE_ID']);
    assertSliceable(text, spans);
  });

  it('rejects a version or variant nibble that no RFC issues', () => {
    expect(isRfcUuid('550e8400-e29b-01d4-a716-446655440000')).toBe(false);
    expect(isRfcUuid('550e8400-e29b-41d4-c716-446655440000')).toBe(false);
    expect(uuidDetector.find('550e8400-e29b-01d4-a716-446655440000')).toEqual([]);
  });

  it('rejects a hex-dashed run of the wrong group lengths', () => {
    expect(uuidDetector.find('550e840-e29b-41d4-a716-446655440000')).toEqual([]);
    expect(uuidDetector.find('550e8400-e29b-41d4-a716-4466554400001')).toEqual([]);
  });

  it('does not fire on a UUID glued to a word', () => {
    expect(uuidDetector.find('x550e8400-e29b-41d4-a716-446655440000')).toEqual([]);
  });

  it('finds a non-RFC GUID only when a label says what it is', () => {
    const nil = '00000000-0000-0000-0000-000000000000';
    expect(labelledUuidDetector.find(nil).map((s) => s.value)).toEqual([nil]);
    // requiresLabel is enforced centrally, so the bare form survives find() and
    // is dropped by detect().
    expect(detect(nil, [uuidDetector, labelledUuidDetector])).toEqual([]);
    expect(kinds(detect(`Geräte-ID ${nil}`, [uuidDetector, labelledUuidDetector]))).toEqual([
      'DEVICE_ID',
    ]);
  });

  it('never reports an RFC-shaped UUID twice', () => {
    const text = 'UUID 550e8400-e29b-41d4-a716-446655440000';
    expect(labelledUuidDetector.find(text)).toEqual([]);
    expect(detect(text, [uuidDetector, labelledUuidDetector])).toHaveLength(1);
  });
});

describe('SESSION_TOKEN', () => {
  it.each([
    ['sessionid=abc123def456ghi789', 'abc123def456ghi789'],
    ['Cookie: JSESSIONID=A1B2C3D4E5F6; Path=/', 'A1B2C3D4E5F6'],
    ['Set-Cookie: session=xyz789; HttpOnly; Secure', 'xyz789'],
    ['PHPSESSID=abc123def456', 'abc123def456'],
    ['sessionid = abc123def456', 'abc123def456'],
    ['csrftoken=Kj8sd9Fj2kL0', 'Kj8sd9Fj2kL0'],
  ])('redacts the value of %s', (text, value) => {
    const spans = sessionTokenDetector.find(text);
    expect(spans.map((s) => s.value)).toEqual([value]);
    expect(kinds(spans)).toEqual(['SESSION_TOKEN']);
    assertSliceable(text, spans);
  });

  it('leaves the cookie name visible', () => {
    const text = 'sessionid=abc123def456ghi789';
    const span = sessionTokenDetector.find(text)[0]!;
    expect(text.slice(0, span.start)).toBe('sessionid=');
  });

  it('strips the quotes from a quoted value', () => {
    const text = 'Cookie: sessionid="abc123def456"';
    expect(values(text, sessionTokenDetector)).toEqual(['abc123def456']);
    assertSliceable(text, sessionTokenDetector.find(text));
  });

  it('does not match a name that merely ends with a known one', () => {
    expect(sessionTokenDetector.find('mysessionid=abc123def456')).toEqual([]);
    expect(sessionTokenDetector.find('x-csrftoken_extra=abc123def456')).toEqual([]);
  });

  it('ignores the assignment a server uses to clear a cookie', () => {
    expect(sessionTokenDetector.find('Set-Cookie: session=deleted; Max-Age=0')).toEqual([]);
    expect(sessionTokenDetector.find('Set-Cookie: session=; Max-Age=0')).toEqual([]);
  });

  it('ignores a value too short to be a session token', () => {
    expect(sessionTokenDetector.find('session=ab12')).toEqual([]);
  });

  it('does not join a name and an assignment across a line break', () => {
    expect(sessionTokenDetector.find('sessionid\n=abc123def456')).toEqual([]);
  });

  it('stops at the end of the cookie, not the end of the header', () => {
    const text = 'Cookie: PHPSESSID=abc123def456; csrftoken=Kj8sd9Fj2kL0';
    expect(values(text, sessionTokenDetector)).toEqual(['abc123def456', 'Kj8sd9Fj2kL0']);
  });

  it('does not swallow the full stop that ends a sentence', () => {
    const text = 'Der Cookie lautet sessionid=abc123def456.';
    expect(values(text, sessionTokenDetector)).toEqual(['abc123def456']);
  });

  it('accepts extra cookie names without touching the defaults', () => {
    const detector = createSessionTokenDetector({ names: ['hushgate_sess'] });
    expect(values('hushgate_sess=abc123def456', detector)).toEqual(['abc123def456']);
    expect(values('sessionid=abc123def456', detector)).toEqual(['abc123def456']);
    expect(sessionTokenDetector.find('hushgate_sess=abc123def456')).toEqual([]);
  });

  it('ships the well-known names as an inspectable list', () => {
    expect(SESSION_COOKIE_NAMES).toContain('JSESSIONID');
    expect(SESSION_COOKIE_NAMES).toContain('PHPSESSID');
    expect(SESSION_TOKEN_PRIORITY).toBeGreaterThan(0);
  });
});

describe('bare twelve-hex MAC addresses', () => {
  it.each([
    '00:1A:2B:3C:4D:5E',
    '00-1A-2B-3C-4D-5E',
    '001A.2B3C.4D5E',
    '00:1a:2b:3c:4d:5e',
  ])('still accepts the delimited form %s', (mac) => {
    expect(values(`nic ${mac} up`, macDetector)).toEqual([mac]);
  });

  it('accepts the undelimited form when a MAC-ish word is in reach', () => {
    expect(values('MAC 001A2B3C4D5E', macDetector)).toEqual(['001A2B3C4D5E']);
    expect(values('hwaddr 001a2b3c4d5e', macDetector)).toEqual(['001a2b3c4d5e']);
    expect(values('001A2B3C4D5E ist die MAC-Adresse', macDetector)).toEqual(['001A2B3C4D5E']);
  });

  it('refuses the undelimited form with no MAC-ish word anywhere', () => {
    expect(macDetector.find('Hash 001A2B3C4D5E im Log')).toEqual([]);
  });

  it('refuses twelve hex characters cut out of a longer hex run', () => {
    expect(macDetector.find('MAC da39a3ee5e6b4b0d3255bfef95601890afd80709')).toEqual([]);
    expect(macDetector.find('MAC 001A2B3C4D5E7')).toEqual([]);
  });

  it('does not eat the tail of a UUID sitting next to the word MAC', () => {
    const text = 'MAC-Adresse unbekannt, Gerät 550e8400-e29b-41d4-a716-446655440000';
    expect(macDetector.find(text)).toEqual([]);
  });

  it('keeps the existing rejections', () => {
    expect(macDetector.find('00:1A-2B:3C:4D:5E')).toEqual([]);
    expect(macDetector.find('00:1A:2B:3C:4D')).toEqual([]);
  });

  it('still slices back to itself', () => {
    const text = 'MAC 001A2B3C4D5E und 00:1A:2B:3C:4D:5E';
    assertSliceable(text, macDetector.find(text));
  });
});
