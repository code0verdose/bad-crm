/**
 * The last thing that looks at an audit payload before it becomes a row or a log line.
 *
 * `rules/observability.mdc` §16 says secrets and decrypted values do not reach `before`/`after`.
 * Until this file existed, that held because every author of every `audit.record(...)` happened to
 * respect it — a property nothing checked, that nothing would notice losing, and whose failure is
 * silent in the worst way: the application works, the tests are green, and the secret sits in a
 * table read by everyone who may read the trail.
 *
 * ## Why a deny list and not the allow list the story asked for
 *
 * STORY-016-02 plans `audit-field-whitelist.ts` — permitted field names per action. It was rejected
 * here, and the reason is what it does on the day it is wrong. An allow list has to name every field
 * of every action; the author who adds an action and forgets the registry gets a payload silently
 * emptied, so the trail loses the answer it exists to give and nobody finds out until somebody asks
 * «what were the permissions before?». It also degrades on its own: a registry of forty actions
 * maintained beside the call sites drifts from them, and a drifted allow list is indistinguishable
 * from a working one. Its cost is paid on ordinary work; a deny list's cost is paid on the field
 * actually named like a secret.
 *
 * What the deny list gives up in return is real and worth stating: it matches names and shapes, not
 * meaning. A secret in a field called `value` is caught only if it *looks* like one, and a secret
 * that looks like a sentence is not caught at all. The corpus test
 * (`test/unit/audit/audit-redaction-corpus.test.ts`) is the other half of the answer — it reads the
 * call sites out of the tree, so a leak has to survive both a shape and a review to reach the trail.
 *
 * ## Why it runs, and not only in a test
 *
 * A test proves the tree is clean at the moment it runs. It says nothing about the branch that was
 * not merged yet, about the job written next month, or about a value that only looks like a token at
 * runtime. This is cheap — one walk over an object of a handful of keys, in a transaction that is
 * already doing an insert — so it runs.
 *
 * ## Why it never throws
 *
 * The record is written inside the transaction of the change that caused it, in an installation with
 * nobody on call. An exception here would roll back somebody's role assignment because a payload had
 * an odd shape. So: **fail closed on the content, fail open on the record** — a payload that cannot
 * be walked is redacted whole, the row is still written, and `_redacted` says what happened.
 */

/** What stands where a value was. A constant, so a reader of the trail can search for it. */
export const AUDIT_REDACTION_MARKER = '[redacted]';

/** Where the paths of everything cut are listed, so the cut is itself a recorded fact. */
export const AUDIT_REDACTED_FIELDS_KEY = '_redacted';

/**
 * Field names that may carry key material.
 *
 * Matched as substrings of the name with separators and case removed, so `refresh_token`,
 * `refreshToken` and `REFRESHTOKEN` are one entry. Deliberately absent: `key` and `hash` on their
 * own — a role's `key` and a content digest are facts the trail is read for, and the dangerous
 * spellings (`apiKey`, `passwordHash`) are already covered by longer entries.
 */
const SECRET_NAME_PARTS = [
  'password',
  'passwd',
  'passphrase',
  'secret',
  'token',
  'apikey',
  'privatekey',
  'credential',
  'recoverycode',
  'mnemonic',
  'plaintext',
  'cipher',
  'authorization',
  'cookie',
  'sessionkey',
  'masterkey',
  'presigned',
  'signedurl',
  'salt',
  'nonce',
] as const;

/**
 * Names that are secrets **only when they are the whole name**.
 *
 * `otp` was a substring entry until the corpus test caught what that does: `totpEnabled` contains
 * it, so the flag saying whether an account had a second factor read as key material. A short token
 * matched anywhere inside a name is a rule that fires on words it has never seen.
 */
const SECRET_EXACT_NAMES = ['otp', 'iv', 'seed'] as const;

/** How deep the walker goes before it stops trusting the structure. Also what ends a cycle. */
const MAX_DEPTH = 6;

/** Below this a string cannot hold a useful amount of key material; above it, it might. */
const OPAQUE_MIN_LENGTH = 40;

const VALUE_SHAPES = [
  /** A password digest, in either of the two formats this codebase and its history produce. */
  /^\$(?:argon2|2[aby]\$)/,
  /** The server-side encryption envelope: `v1:<iv>:<tag>:<ciphertext>`. */
  /^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/,
  /** A JWT. */
  /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/,
  /** A signed URL — the query string is the credential, which is why the whole value goes. */
  /[?&](?:x-amz-signature|x-amz-credential|signature|token|sig)=/i,
  /** An opaque blob: long, unbroken, and made of nothing but transport alphabet. */
  new RegExp(`^[A-Za-z0-9+/_=-]{${String(OPAQUE_MIN_LENGTH)},}$`),
] as const;

const normalize = (key: string): string => key.toLowerCase().replaceAll(/[^a-z0-9]/g, '');

/**
 * A name that says «this may be key material».
 *
 * The `enc` suffix is the column convention of this repository (`totpSecretEnc`, `dataEnc`): it
 * marks a value that is ciphertext, and ciphertext in the trail is still the thing the vault exists
 * to keep out of it.
 */
const nameSuggestsSecret = (key: string): boolean => {
  const normalized = normalize(key);

  return (
    SECRET_NAME_PARTS.some((part) => normalized.includes(part)) ||
    SECRET_EXACT_NAMES.some((name) => normalized === name) ||
    (normalized.length > 3 && normalized.endsWith('enc'))
  );
};

const shapeSuggestsSecret = (value: string): boolean =>
  VALUE_SHAPES.some((shape) => shape.test(value));

/**
 * Whether one value goes or stays.
 *
 * The name alone is not enough, and the pairing with the value's type is what makes the deny list
 * usable: `recoveryCodesDeleted: 8` and `recoveryCodes: ['…']` differ by type, not by name, and a
 * rule that read only names would erase the count as well. A number, a boolean and a null cannot
 * carry a secret, so a suspicious name over one of them is left alone.
 */
const isSecret = (key: string, value: unknown): boolean => {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return false;
  if (nameSuggestsSecret(key)) return true;

  return typeof value === 'string' && shapeSuggestsSecret(value);
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

interface Walk {
  readonly value: unknown;
  readonly cut: readonly string[];
}

const walkValue = (value: unknown, path: string, depth: number): Walk => {
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return { value: AUDIT_REDACTION_MARKER, cut: [path] };

    const items = value.map((item, index) =>
      walkValue(item, `${path}[${String(index)}]`, depth + 1),
    );

    return { value: items.map((item) => item.value), cut: items.flatMap((item) => item.cut) };
  }

  if (isPlainObject(value)) {
    if (depth >= MAX_DEPTH) return { value: AUDIT_REDACTION_MARKER, cut: [path] };

    return walkObject(value, path, depth + 1);
  }

  return { value, cut: [] };
};

const walkObject = (source: Record<string, unknown>, prefix: string, depth: number): Walk => {
  const result: Record<string, unknown> = {};
  const cut: string[] = [];

  for (const [key, value] of Object.entries(source)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;

    if (isSecret(key, value)) {
      result[key] = AUDIT_REDACTION_MARKER;
      cut.push(path);
      continue;
    }

    const walked = walkValue(value, path, depth);

    result[key] = walked.value;
    cut.push(...walked.cut);
  }

  return { value: result, cut };
};

/**
 * The payload as it may be written down.
 *
 * `undefined` in, `undefined` out: «nothing to record» is not the same as «an empty payload», and
 * the adapter writes the two differently.
 */
export const redactAuditPayload = (
  payload: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined => {
  if (payload === undefined) return undefined;

  try {
    const walked = walkObject(payload, '', 1);
    const value = walked.value as Record<string, unknown>;

    return walked.cut.length === 0
      ? value
      : { ...value, [AUDIT_REDACTED_FIELDS_KEY]: [...walked.cut] };
  } catch {
    // A payload that cannot even be read is a payload nobody can vouch for. It is dropped whole
    // rather than partially, and the row is still written — see the note on failing open above.
    return { [AUDIT_REDACTED_FIELDS_KEY]: ['*'] };
  }
};
