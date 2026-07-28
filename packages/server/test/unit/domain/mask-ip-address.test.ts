import { describe, expect, it } from 'vitest';

import { MASKED_IP_UNKNOWN, maskIpAddress } from '@/domain/identity/mask-ip-address.util.js';

/**
 * The privacy rule of `CLAUDE.md` («Персональные данные») applied where it is cheapest to keep: an
 * IP address is personal data, so the full one is never stored at all.
 *
 * The masking happens **at sign-in, before the row is written** — not on the way out. The row keeps
 * `ip_hash` (which compares sessions with each other and cannot be read back) and `ip_masked`
 * (which is shown). A "mask on display" reading of STORY-006-04 is not implementable: what comes
 * out of the database is a hash, and nothing masks a hash into an address.
 *
 * The prefix lengths are the usual privacy compromise: /24 keeps the network and drops the host,
 * /48 keeps the site and drops everything a provider hands to one customer. Both leave the signal
 * the screen exists for — "this session is from a city I have never been to" — and neither
 * identifies the machine.
 */
describe('masking an address for the active-sessions screen', () => {
  it.each([
    ['203.0.113.42', '203.0.113.0/24'],
    ['203.0.113.0', '203.0.113.0/24'],
    ['8.8.8.8', '8.8.8.0/24'],
    ['0.0.0.0', '0.0.0.0/24'],
    ['255.255.255.255', '255.255.255.0/24'],
  ])('drops the host half of IPv4 %s', (address, expected) => {
    expect(maskIpAddress(address)).toBe(expected);
  });

  it.each([
    ['2001:db8:85a3:8d3:1319:8a2e:370:7348', '2001:db8:85a3::/48'],
    ['2001:0db8:85a3:0000:0000:8a2e:0370:7334', '2001:db8:85a3::/48'],
    ['2001:DB8:85A3::1', '2001:db8:85a3::/48'],
    ['2001:db8::', '2001:db8:0::/48'],
    ['::1', '::/48'],
    ['::', '::/48'],
    ['fe80::1ff:fe23:4567:890a', 'fe80:0:0::/48'],
  ])('keeps the site half of IPv6 %s', (address, expected) => {
    expect(maskIpAddress(address)).toBe(expected);
  });

  /**
   * The shape Node hands over when the socket is IPv6 and the peer is IPv4 — which is what every
   * dual-stack deployment behind a proxy produces. Masking it as an IPv6 address would keep the
   * whole v4 address inside the first three groups, i.e. store exactly what must not be stored.
   */
  it.each([
    ['::ffff:203.0.113.42', '203.0.113.0/24'],
    ['::FFFF:203.0.113.42', '203.0.113.0/24'],
  ])('treats the IPv4-mapped address %s as IPv4', (address, expected) => {
    expect(maskIpAddress(address)).toBe(expected);
  });

  it('drops an interface zone before masking', () => {
    expect(maskIpAddress('fe80::1%eth0')).toBe('fe80:0:0::/48');
  });

  it('trims surrounding whitespace, which a header forwards unchanged', () => {
    expect(maskIpAddress('  203.0.113.42  ')).toBe('203.0.113.0/24');
  });

  /**
   * The column is NOT NULL, so the function has to answer something for input it cannot read — and
   * the answer is a stated "unknown" rather than a guess or a fragment of an unparsed string. The
   * cases below are real: `X-Forwarded-For` is attacker-controlled, a unix socket has no peer
   * address at all, and a value with a port is not an address.
   */
  it.each([
    ['', 'empty'],
    ['   ', 'blank'],
    ['unknown', 'a literal the proxy wrote'],
    ['203.0.113', 'a truncated IPv4'],
    ['203.0.113.42.7', 'five octets'],
    ['203..113.42', 'an empty octet, which `Number("")` would otherwise read as zero'],
    // Each position separately: an address is refused wherever the bad octet sits, and a check that
    // only looked at the last one would mask `256.0.113.42` to a network nobody is on.
    ['256.0.113.42', 'the first octet out of range'],
    ['203.256.113.42', 'the second octet out of range'],
    ['203.0.256.42', 'the third octet out of range'],
    ['203.0.113.256', 'the fourth octet out of range'],
    ['203.0.113.-1', 'a negative octet'],
    ['203.0.113.0x2a', 'a hexadecimal octet'],
    ['203.0.113.042', 'a zero-padded octet, which is octal to some parsers and decimal to others'],
    ['203.0.113.42:51234', 'an address with a port'],
    ['2001:db8:85a3:8d3:1319:8a2e:370:7348:9999', 'nine groups'],
    [
      '2001:db8:85a3:8d3:1319:8a2e:370:7348::',
      'eight groups and an elision, which stands for no group at all',
    ],
    ['2001:db8::85a3::1', 'two elisions'],
    ['::ffff:203.0.113.256', 'an IPv4-mapped address whose embedded IPv4 is not one'],
    ['64:ff9b::203.0.113', 'an embedded IPv4 that is truncated'],
    ['2001:zzzz::1', 'a non-hex group'],
    ['20011:db8::1', 'a five-digit group'],
    ['<script>', 'markup'],
  ])('answers unknown for %s (%s)', (address) => {
    expect(maskIpAddress(address)).toBe(MASKED_IP_UNKNOWN);
  });

  it('answers unknown when there is no address at all', () => {
    expect(maskIpAddress(undefined)).toBe(MASKED_IP_UNKNOWN);
  });

  /**
   * The property that makes the column safe to keep: whatever the input, the output is one of a
   * bounded set of prefixes and never carries the host part of the address it came from.
   */
  it('never returns the address it was given', () => {
    for (const address of [
      '203.0.113.42',
      '2001:db8:85a3:8d3:1319:8a2e:370:7348',
      '::ffff:1.2.3.4',
    ]) {
      expect(maskIpAddress(address)).not.toContain(address);
    }
  });
});
