import { createHash } from 'node:crypto';

import {
  type ActorSubject,
  type IpEmailSubject,
  type RateLimitPolicy,
  type RateLimitSubjects,
} from '@/application/platform/ports/rate-limit.port.js';
import { maskIpAddress } from '@/domain/identity/mask-ip-address.util.js';

/** Any of the four subject shapes, narrowed structurally below rather than by policy name. */
type AnyRateLimitSubject = RateLimitSubjects[RateLimitPolicy];

export interface RateLimitKey {
  /** What the counter is stored under. Contains no address and no email in clear. */
  readonly value: string;
  /** The same subject in a form a log line may carry (rules/observability.mdc, rule 5). */
  readonly label: string;
}

/** The bucket every request whose address could not be read shares. */
const UNKNOWN_ADDRESS = 'unknown';

/** Enough of a digest to correlate two log lines, too little to enumerate against a word list. */
const LABEL_DIGEST_LENGTH = 16;

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

/**
 * The same normalisation the identity schema applies: addresses live in a `citext` column, so two
 * spellings that differ only in case are one account and must be one counter. Without this the
 * budget is five attempts *per spelling*, which is as many attempts as an attacker wants.
 */
const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/**
 * The subject of a limit, as a storage key and as a loggable label.
 *
 * Both are produced together on purpose: they are two renderings of one value, and the day they are
 * computed in two places is the day a log line names a different subject than the counter it
 * describes.
 *
 * **Neither rendering carries an address or an email in clear.** The key hashes them — the counter
 * still separates two addresses exactly, but Redis, its persistence file and its backups hold no
 * personal data (`CLAUDE.md`, «Персональные данные»; `mask-ip-address.util.ts` on why a full
 * address is not written anywhere). The label carries the masked network, which is what a person
 * reading the log can act on, and a short digest of the address, which is what lets them see that
 * the same account is being hammered from three networks.
 *
 * `userId` is neither hashed nor masked: it is an opaque identifier, and identifiers are exactly
 * what the observability rule says logs are *for*.
 */
export const rateLimitKeyOf = <P extends RateLimitPolicy>(
  policy: P,
  subject: RateLimitSubjects[P],
): RateLimitKey => {
  const parts = subjectParts(subject);

  return {
    value: `${policy}:${parts.map((part) => `${part.name}=${part.key}`).join('|')}`,
    label: parts.map((part) => `${part.name}=${part.label}`).join(' '),
  };
};

interface SubjectPart {
  readonly name: string;
  readonly key: string;
  readonly label: string;
}

/**
 * Which fields the key is built from, decided by what the subject carries rather than by the policy.
 *
 * An authenticated caller is counted as that caller, whatever address they came from — a phone that
 * switches from wifi to mobile data must not get a second budget. An anonymous caller is counted by
 * address, and a sign-in attempt by **both** address and account, which is the property the port
 * documents at length.
 */
const subjectParts = (subject: AnyRateLimitSubject): readonly SubjectPart[] => {
  // Read as optionals rather than narrowed with `in`: every shape that has no `userId` has an
  // `ipAddress`, so an `in` guard for the address would be a branch no input can take — dead code
  // in the one file where "which fields decide the key" has to stay readable.
  const { userId, ipAddress, email } = subject as Partial<IpEmailSubject & ActorSubject>;

  if (userId !== undefined) {
    return [{ name: 'user', key: userId, label: userId }];
  }

  const masked = maskIpAddress(ipAddress);
  const parts: SubjectPart[] = [
    {
      name: 'ip',
      // An unreadable address is one shared bucket, not one bucket per malformed value: the
      // alternative lets a caller mint a fresh budget by varying a header nobody can parse.
      // `maskIpAddress` is what decides readable from not, so there is one parser, not two.
      key:
        ipAddress === undefined || masked === UNKNOWN_ADDRESS ? UNKNOWN_ADDRESS : digest(ipAddress),
      label: masked,
    },
  ];

  if (email !== undefined) {
    const hashed = digest(normalizeEmail(email));

    parts.push({
      name: 'email',
      key: hashed,
      label: `sha256:${hashed.slice(0, LABEL_DIGEST_LENGTH)}`,
    });
  }

  return parts;
};
