import { describe, expect, it } from 'vitest';
import { emailDetector, isValidEmail } from '../src/detectors/email.js';
import { classifyPhone, phoneDetector } from '../src/detectors/phone.js';
import {
  ipv4Detector,
  ipv6Detector,
  isValidIpv4,
  isValidIpv6,
  macDetector,
} from '../src/detectors/network.js';
import { createDobDetector, isLeapYear, isRealDate } from '../src/detectors/dob.js';
import type { Detector } from '../src/types.js';

const values = (text: string, detector: Detector): string[] =>
  detector.find(text).map((s) => s.value);

describe('EMAIL', () => {
  it.each([
    'johan@example.com',
    'j.becker+llm@sub.example.co.uk',
    "o'brien@example.org",
    'x@y.de',
  ])('accepts %s', (address) => {
    expect(isValidEmail(address)).toBe(true);
    expect(values(`hi ${address} bye`, emailDetector)).toEqual([address]);
  });

  it.each(['no-at-sign.example.com', 'a@b', 'a@b.c', '@example.com', 'a..b@example.com'])(
    'rejects %s',
    (address) => {
      expect(emailDetector.find(address)).toEqual([]);
    },
  );

  it('does not include a trailing sentence period', () => {
    expect(values('Write to johan@example.com.', emailDetector)).toEqual(['johan@example.com']);
  });

  it('does not start the local part inside a non-ASCII word', () => {
    expect(values('ünal@example.de', emailDetector)).toEqual([]);
  });

  it('rejects a local part over 64 characters', () => {
    expect(isValidEmail(`${'a'.repeat(65)}@example.com`)).toBe(false);
  });

  it('finds every address in a list', () => {
    const text = 'cc: a@x.de, b@y.com; d@z.org';
    expect(values(text, emailDetector)).toEqual(['a@x.de', 'b@y.com', 'd@z.org']);
  });
});

describe('PHONE', () => {
  it.each([
    ['+49 721 1234567', 'e164'],
    ['+4972112345670', 'e164'],
    ['0049 721 1234567', 'international-00'],
    ['0049-721-1234567', 'international-00'],
    ['0721/1234567', 'german-national'],
    ['0721 123 45 67', 'german-national'],
    ['030 12345678', 'german-national'],
    ['01711234567', 'german-national'],
    ['+49 (0)721 123456', 'e164'],
  ] as const)('finds %s as %s', (text, form) => {
    expect(values(`Tel: ${text}`, phoneDetector)).toEqual([text]);
    expect(classifyPhone(text)?.form).toBe(form);
  });

  it('drops the (0) trunk prefix when normalising', () => {
    expect(classifyPhone('+49 (0)721 123456')?.digits).toBe('49721123456');
  });

  it.each(['12345', '0 1', '+1 23', '00 1234'])('rejects %s', (text) => {
    expect(phoneDetector.find(text)).toEqual([]);
  });

  it('does not treat a German date as a phone number', () => {
    expect(phoneDetector.find('01.02.1990')).toEqual([]);
  });

  it('does not match inside an ISO timestamp', () => {
    expect(phoneDetector.find('2024-01-02T10:00:00Z')).toEqual([]);
  });

  it('does not match a version string', () => {
    expect(phoneDetector.find('version 0.5.1')).toEqual([]);
  });

  it('rejects a run longer than E.164 allows', () => {
    expect(phoneDetector.find('+4972112345678901234')).toEqual([]);
  });

  it('does not glue two numbers separated by a double space', () => {
    expect(values('0721 1234567  0721 7654321', phoneDetector)).toEqual([
      '0721 1234567',
      '0721 7654321',
    ]);
  });
});

describe('IPV4', () => {
  it.each(['192.168.0.1', '10.0.0.255', '0.0.0.0', '255.255.255.255'])('accepts %s', (ip) => {
    expect(isValidIpv4(ip)).toBe(true);
    expect(values(`from ${ip} ok`, ipv4Detector)).toEqual([ip]);
  });

  it('rejects octets above 255', () => {
    expect(isValidIpv4('256.1.1.1')).toBe(false);
    expect(isValidIpv4('1.1.1.300')).toBe(false);
    expect(ipv4Detector.find('host 999.1.2.3 down')).toEqual([]);
    expect(ipv4Detector.find('host 192.168.1.256 down')).toEqual([]);
  });

  it('rejects leading zeros', () => {
    expect(isValidIpv4('192.168.01.1')).toBe(false);
  });

  it('does not match a fragment of a five-part dotted string', () => {
    expect(ipv4Detector.find('1.2.3.4.5')).toEqual([]);
  });
});

describe('IPV6', () => {
  it.each([
    '2001:0db8:85a3:0000:0000:8a2e:0370:7334',
    '2001:db8:85a3::8a2e:370:7334',
    '2001:db8::1',
    '::1',
    'fe80::1ff:fe23:4567:890a',
    '::ffff:192.0.2.128',
    '2001:db8::',
  ])('accepts %s', (ip) => {
    expect(isValidIpv6(ip)).toBe(true);
    expect(values(`peer ${ip} ok`, ipv6Detector)).toEqual([ip]);
  });

  it('handles :: compression arithmetic', () => {
    // Eight explicit groups is fine; nine is not.
    expect(isValidIpv6('1:2:3:4:5:6:7:8')).toBe(true);
    expect(isValidIpv6('1:2:3:4:5:6:7:8:9')).toBe(false);
    // With ::, at least one group must actually be elided.
    expect(isValidIpv6('1:2:3:4::5:6:7:8')).toBe(false);
    expect(isValidIpv6('1:2:3::5:6:7:8')).toBe(true);
  });

  it('rejects two compressions', () => {
    expect(isValidIpv6('2001::db8::1')).toBe(false);
  });

  it('rejects a group longer than four hex digits', () => {
    expect(isValidIpv6('20011:db8::1')).toBe(false);
  });

  it('rejects an invalid embedded IPv4 tail', () => {
    expect(isValidIpv6('::ffff:999.0.2.128')).toBe(false);
  });

  it('does not accept the bare unspecified address', () => {
    // `::` shows up as a C++ scope operator far more often than as an address.
    expect(isValidIpv6('::')).toBe(false);
    expect(ipv6Detector.find('std::vector<int> v;')).toEqual([]);
  });

  it('trims trailing sentence punctuation', () => {
    expect(values('Peer is 2001:db8::1.', ipv6Detector)).toEqual(['2001:db8::1']);
    expect(values('Peer is 2001:db8::1, retry.', ipv6Detector)).toEqual(['2001:db8::1']);
  });

  it('does not treat a clock time as an address', () => {
    expect(ipv6Detector.find('meeting at 12:34:56')).toEqual([]);
  });

  it('does not start inside a word', () => {
    expect(ipv6Detector.find('cafe2001:db8::1')).toEqual([]);
  });
});

describe('MAC', () => {
  it.each(['00:1A:2B:3C:4D:5E', '00-1a-2b-3c-4d-5e', '001a.2b3c.4d5e'])(
    'accepts %s',
    (mac) => {
      expect(values(`nic ${mac} up`, macDetector)).toEqual([mac]);
    },
  );

  it('rejects mixed separators', () => {
    expect(macDetector.find('00:1A-2B:3C:4D:5E')).toEqual([]);
  });

  it('rejects a five-group address', () => {
    expect(macDetector.find('00:1A:2B:3C:4D')).toEqual([]);
  });

  it('is not mistaken for an IPv6 address', () => {
    expect(isValidIpv6('00:1A:2B:3C:4D:5E')).toBe(false);
  });
});

describe('DATE_OF_BIRTH', () => {
  const detector = createDobDetector({ minYear: 1900, maxYear: 2013 });

  it.each(['01.02.1990', '1.2.1990', '29.02.2000', '1990-02-01'])('accepts %s', (date) => {
    expect(values(`geboren am ${date}`, detector)).toEqual([date]);
  });

  it('rejects impossible calendar dates', () => {
    expect(isRealDate(1990, 2, 30)).toBe(false);
    expect(isRealDate(1990, 13, 1)).toBe(false);
    expect(detector.find('31.04.1990')).toEqual([]);
    expect(detector.find('1990-02-30')).toEqual([]);
  });

  it('applies leap-year rules', () => {
    expect(isLeapYear(2000)).toBe(true);
    expect(isLeapYear(1900)).toBe(false);
    expect(detector.find('29.02.1900')).toEqual([]);
    expect(values('29.02.2000', detector)).toEqual(['29.02.2000']);
  });

  it('rejects years outside the configured window', () => {
    expect(detector.find('01.02.2024')).toEqual([]);
    expect(detector.find('2024-01-02')).toEqual([]);
    expect(detector.find('01.02.1850')).toEqual([]);
  });

  it('does not match a fragment of a longer dotted number', () => {
    expect(detector.find('1.2.1990.4')).toEqual([]);
  });
});
