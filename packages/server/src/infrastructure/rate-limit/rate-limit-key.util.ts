import { createHash } from 'node:crypto';

import {
  type ActorSubject,
  type IpEmailSubject,
  type IpSubject,
  type IpUserSubject,
  type MfaTokenSubject,
  type RateLimitPolicy,
  type RateLimitSubjects,
  type UserSubject,
} from '@/application/platform/ports/rate-limit.port.js';
import { maskIpAddress } from '@/domain/identity/mask-ip-address.util.js';

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

interface SubjectPart {
  readonly name: string;
  readonly key: string;
  readonly label: string;
}

/** `userId` is neither hashed nor masked: it is an opaque identifier, and identifiers are exactly
 * what the observability rule says logs are *for*. */
const userPart = (userId: string): SubjectPart => ({ name: 'user', key: userId, label: userId });

/**
 * An unreadable or absent address is one shared bucket, not one bucket per malformed value: the
 * alternative lets a caller mint a fresh budget by varying a header nobody can parse. `maskIpAddress`
 * is what decides readable from not, so there is one parser, not two — every subject that carries an
 * address renders it through this one function.
 */
const ipPart = (ipAddress: string | undefined): SubjectPart => {
  const masked = maskIpAddress(ipAddress);

  return {
    name: 'ip',
    key:
      ipAddress === undefined || masked === UNKNOWN_ADDRESS ? UNKNOWN_ADDRESS : digest(ipAddress),
    label: masked,
  };
};

const emailPart = (email: string): SubjectPart => {
  const hashed = digest(normalizeEmail(email));

  return { name: 'email', key: hashed, label: `sha256:${hashed.slice(0, LABEL_DIGEST_LENGTH)}` };
};

/**
 * A `jti` is an opaque identifier the server itself mints inside a signed JWT — never a value a
 * caller supplies — which puts it in the same category `userId` is in, not the category `email` and
 * `ipAddress` are. Written to the key and the label unhashed, for the same reason `userId` is: there
 * is no personal data to protect and nothing outside this process could have chosen the value.
 */
const jtiPart = (jti: string): SubjectPart => ({ name: 'jti', key: jti, label: jti });

type SubjectRenderer<S> = (subject: S) => readonly SubjectPart[];

/** The user when there is one, the address otherwise — never both at once. */
const renderActor: SubjectRenderer<ActorSubject> = ({ userId, ipAddress }) =>
  userId !== undefined ? [userPart(userId)] : [ipPart(ipAddress)];

/** Both halves, always — an address-only or email-only counter is not the limit this pair is for. */
const renderIpEmail: SubjectRenderer<IpEmailSubject> = ({ ipAddress, email }) => [
  ipPart(ipAddress),
  emailPart(email),
];

/** The `IpEmailSubject` pair with `userId` in place of `email` — see `IpUserSubject`'s own doc. */
const renderIpUser: SubjectRenderer<IpUserSubject> = ({ ipAddress, userId }) => [
  ipPart(ipAddress),
  userPart(userId),
];

const renderIp: SubjectRenderer<IpSubject> = ({ ipAddress }) => [ipPart(ipAddress)];

const renderUser: SubjectRenderer<UserSubject> = ({ userId }) => [userPart(userId)];

const renderMfaToken: SubjectRenderer<MfaTokenSubject> = ({ jti }) => [jtiPart(jti)];

/**
 * Which renderer each policy uses — keyed on the **policy**, not sniffed from the subject's runtime
 * shape.
 *
 * It used to be the other way around: one function read whichever fields the value happened to
 * carry and decided from that alone. That held up as long as every "combine both fields, always"
 * subject was structurally distinct from every "prefer one field over the other" subject — a
 * coincidence that broke the moment `IpUserSubject` was added for `mfa_recovery_consume_attempt`.
 * `{ userId: '01J…', ipAddress: '203.0.113.42' }` is a value `ActorSubject` and `IpUserSubject` can
 * both produce, byte for byte, and the two are supposed to render *different* keys from it —
 * `ActorSubject` drops the address once a user is known, `IpUserSubject` never drops either half.
 * No inspection of that one object recovers which rule applies; the shape alone is genuinely
 * ambiguous. Only the policy name disambiguates it, and the policy is closed and known at every call
 * site, so it is the dispatch key.
 *
 * The mapped type below is what makes this a type-level guarantee rather than a convention: it
 * forces each entry's renderer to accept exactly the subject shape `RateLimitSubjects` declares for
 * that policy, so wiring `renderActor` where `mfa_recovery_consume_attempt` needs `renderIpUser`
 * does not compile — swapping the two is exactly the mistake the ambiguity above invites. That is
 * what "express the difference in types, not a comment" means in practice here: this table is the
 * type, the paragraph above only explains why it has to exist.
 */
const SUBJECT_RENDERERS: {
  readonly [P in RateLimitPolicy]: SubjectRenderer<RateLimitSubjects[P]>;
} = {
  auth_attempt: renderIpEmail,
  organization_registration: renderIp,
  api_request: renderActor,
  heavy_operation: renderUser,
  client_error_report: renderActor,
  invitation_create: renderUser,
  invitation_accept: renderIp,
  mfa_setup_attempt: renderUser,
  mfa_reauth_attempt: renderUser,
  mfa_verify_attempt: renderMfaToken,
  mfa_verify_account_attempt: renderIpUser,
  mfa_recovery_consume_attempt: renderIpUser,
  mfa_admin_reset_attempt: renderUser,
};

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
 */
export const rateLimitKeyOf = <P extends RateLimitPolicy>(
  policy: P,
  subject: RateLimitSubjects[P],
): RateLimitKey => {
  const parts = SUBJECT_RENDERERS[policy](subject);

  return {
    value: `${policy}:${parts.map((part) => `${part.name}=${part.key}`).join('|')}`,
    label: parts.map((part) => `${part.name}=${part.label}`).join(' '),
  };
};
