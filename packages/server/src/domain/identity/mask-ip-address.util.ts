/**
 * The redacted form of a peer address, computed **before** anything is stored.
 *
 * An IP address is personal data (`CLAUDE.md`, «Персональные данные»), and this product never keeps
 * a full one: `Session.ipHash` is a digest that answers "is this the same address as that one" and
 * can never be read back, and `Session.ipMasked` — the value this function produces — is the only
 * thing a screen may show. STORY-006-04 asks for "the IP in masked form" on `/settings/security`,
 * and the masking has to happen here rather than on the way out, because what comes out of the
 * database is a hash and no function turns a hash into an address.
 *
 * **Why an address is shown at all.** The screen exists so that somebody recognises a session as
 * not theirs, and device and time do not carry that signal: the same browser and a plausible hour
 * look normal. A network that is suddenly in another country does not.
 *
 * **Why /24 and /48.** They are the usual compromise between that signal and the data minimisation
 * the rule demands: /24 keeps the network and drops the host, /48 keeps the site and drops
 * everything a provider hands to a single customer. What is dropped is dropped at the door — the
 * full address is not written anywhere, not even to a log (`rules/observability.mdc`).
 *
 * The result is a **display string**, not a value to feed back into an address library: it is
 * stored, rendered, and compared with nothing.
 */

/**
 * The answer for input that is not an address.
 *
 * `Session.ipMasked` is NOT NULL — the column was made so deliberately while the table had no rows,
 * because a nullable column is nullable forever and every reader then has to carry a branch for the
 * absent case. So there is one stated value for "the deployment gave us nothing usable" instead of
 * a fragment of whatever arrived. It happens: `X-Forwarded-For` is written by whatever sits in
 * front and is not trustworthy, and a request over a unix socket has no peer address at all.
 */
export const MASKED_IP_UNKNOWN = 'unknown';

const DECIMAL_OCTET = /^\d{1,3}$/;

const IPV6_GROUP = /^[0-9a-f]{1,4}$/i;

const IPV6_GROUP_COUNT = 8;

/** `/48` — the first three groups of the address are kept, the other five are dropped. */
const IPV6_KEPT_GROUPS = 3;

type Octets = readonly [number, number, number, number];

/**
 * An octet, or `undefined` when it is not one.
 *
 * A zero-padded octet is refused rather than read: `042` is decimal 42 to one parser and octal 34 to
 * another (`inet_aton` still reads it as octal), so the same string masks to two different networks
 * depending on who reads it. There is no reading that is safe to guess at here. The same refusal
 * covers the empty string, which `Number('')` would otherwise read as zero and turn `203..113.42`
 * into a valid address.
 */
const octet = (text: string): number | undefined => {
  if (!DECIMAL_OCTET.test(text)) return undefined;
  if (text.length > 1 && text.startsWith('0')) return undefined;

  const value = Number(text);

  return value <= 255 ? value : undefined;
};

/** The four octets of a dotted address, each one validated. */
const octetsOf = (text: string): Octets | undefined => {
  const parts = text.split('.');

  if (parts.length !== 4) return undefined;

  const [first, second, third, fourth] = parts.map(octet);

  // Checked one by one rather than with `some`, so that the tuple this returns is four numbers to
  // the type system as well: everything downstream then reads them without a fallback for a case
  // that cannot happen, and no branch here is unreachable.
  if (first === undefined || second === undefined || third === undefined || fourth === undefined) {
    return undefined;
  }

  return [first, second, third, fourth];
};

const maskIpv4 = (address: string): string | undefined => {
  const octets = octetsOf(address);

  if (octets === undefined) return undefined;

  const [first, second, third] = octets;

  return `${first}.${second}.${third}.0/24`;
};

/** `cb00` → `[203, 0]`: the two halves of one IPv6 group, read as two octets. */
const groupToOctets = (group: number): [number, number] => [group >>> 8, group & 0xff];

/**
 * The groups of an IPv6 address, `::` expanded, or `undefined` when the text is not one.
 *
 * Deliberately strict. This value ends up on a screen a person uses to decide whether to revoke a
 * session, and an address that "almost" parsed would be a different network than the one the
 * request came from.
 */
const parseIpv6 = (address: string): number[] | undefined => {
  const parseHalf = (part: string): number[] | undefined => {
    if (part === '') return [];

    const groups = part.split(':');

    if (!groups.every((group) => IPV6_GROUP.test(group))) return undefined;

    return groups.map((group) => Number.parseInt(group, 16));
  };

  const [headText = '', tailText = '', ...extra] = address.split('::');

  // Two elisions cannot be resolved: `1::2::3` says "zeros here and zeros there" without saying how
  // many of each.
  if (extra.length > 0) return undefined;

  const head = parseHalf(headText);
  const tail = parseHalf(tailText);

  if (head === undefined || tail === undefined) return undefined;

  if (!address.includes('::')) {
    return head.length === IPV6_GROUP_COUNT ? head : undefined;
  }

  const elided = IPV6_GROUP_COUNT - head.length - tail.length;

  // `::` stands for *at least one* group of zeros: an address that already has eight groups and an
  // elision is malformed rather than generous.
  if (elided < 1) return undefined;

  return [...head, ...Array.from({ length: elided }, () => 0), ...tail];
};

/**
 * `::ffff:203.0.113.42` — the shape Node reports whenever the listening socket is IPv6 and the peer
 * is IPv4, which is what a dual-stack deployment behind a proxy produces by default.
 *
 * Masking it as IPv6 would keep the *whole* v4 address, since all four octets live inside the last
 * two groups and /48 cuts nothing off them. Recognised, therefore, and masked as what it is.
 */
const mappedIpv4Of = (groups: number[]): string | undefined => {
  const isMapped =
    groups.slice(0, 5).every((group) => group === 0) &&
    groups[5] === 0xffff &&
    groups.length === IPV6_GROUP_COUNT;

  if (!isMapped) return undefined;

  // `slice`/`flatMap` rather than `groups[6]`, so there is no index to defend against: the two
  // trailing groups become four octets and the four join into the address they encode.
  return groups.slice(6).flatMap(groupToOctets).join('.');
};

const maskIpv6 = (address: string): string | undefined => {
  // The tail may be a dotted IPv4 (`::ffff:203.0.113.42`, `64:ff9b::203.0.113.42`). Rewritten into
  // two hexadecimal groups first, so the parser below has one syntax to handle.
  const lastColon = address.lastIndexOf(':');
  const tail = address.slice(lastColon + 1);

  let text = address;

  if (tail.includes('.')) {
    const octets = octetsOf(tail);

    if (octets === undefined) return undefined;

    const [first, second, third, fourth] = octets;
    const high = (first << 8) | second;
    const low = (third << 8) | fourth;

    text = `${address.slice(0, lastColon + 1)}${high.toString(16)}:${low.toString(16)}`;
  }

  const groups = parseIpv6(text);

  if (groups === undefined) return undefined;

  const mapped = mappedIpv4Of(groups);

  if (mapped !== undefined) return maskIpv4(mapped);

  const kept = groups.slice(0, IPV6_KEPT_GROUPS);

  // All three zero: `::/48` rather than `0:0:0::/48`, which is the same prefix written the long way.
  if (kept.every((group) => group === 0)) return '::/48';

  return `${kept.map((group) => group.toString(16)).join(':')}::/48`;
};

/**
 * The masked form of `address`, or `MASKED_IP_UNKNOWN` when it is not an address this can read.
 *
 * Never throws and never returns anything derived from an unparsed input: the caller writes the
 * result into a NOT NULL column on the sign-in path, where a thrown error would refuse a valid
 * login over an unreadable header.
 */
export const maskIpAddress = (address: string | undefined): string => {
  // An interface zone (`fe80::1%eth0`) names a local interface, not part of the address.
  const text = (address ?? '').trim().replace(/%.*$/, '');

  if (text === '') return MASKED_IP_UNKNOWN;

  const masked = text.includes(':') ? maskIpv6(text) : maskIpv4(text);

  return masked ?? MASKED_IP_UNKNOWN;
};
