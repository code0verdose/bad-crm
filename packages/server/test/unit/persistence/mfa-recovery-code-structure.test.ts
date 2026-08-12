import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { REDACTED_PATHS } from '@/infrastructure/logging/log-redaction.constant.js';

/**
 * The structural half of STORY-013-01 acceptance 7 and STORY-013-02 acceptance 9: a TOTP secret and
 * a recovery code exist in plaintext for exactly as long as one request needs them, and neither is
 * ever persisted or logged in the clear. `prisma/schema.prisma`'s own comment on `MfaRecoveryCode`
 * points here by name ("see `mfa-recovery-code-structure.test.ts` for the structural assertion that
 * the column does not exist") — this is that file.
 *
 * Two halves, because "never written down" has two ways to fail independently: a plaintext column
 * added to the schema, and a plaintext value handed to the logger under a field name the redaction
 * net does not know. Neither is provable by exercising a use-case with a scripted double — a fake
 * repository has no schema to violate, and a fake logger has no redaction path to skip. Both are
 * read directly from the artifact that would actually carry the leak: the schema source, and the
 * shared redaction constant every adapter's logger is built from
 * (`infrastructure/logging/pino-logger.adapter.ts`).
 */

const SCHEMA_PATH = fileURLToPath(new URL('../../../prisma/schema.prisma', import.meta.url));

const schemaSource = readFileSync(SCHEMA_PATH, 'utf8');

/** The body of one `model Name { ... }` block, or throws if the schema no longer declares it. */
const modelBody = (modelName: string): string => {
  const match = new RegExp(`model ${modelName} \\{([\\s\\S]*?)\\n\\}`).exec(schemaSource);

  if (match?.[1] === undefined) {
    throw new Error(`schema.prisma: no "model ${modelName} { ... }" block found`);
  }

  return match[1];
};

/** Field names declared in a model body — the first identifier on each `camelCase` column line. */
const fieldNamesOf = (body: string): readonly string[] =>
  body
    .split('\n')
    .map((line) => /^\s{2}([a-zA-Z][a-zA-Z0-9]*)\s+\S/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);

describe('no plaintext recovery code column, ever', () => {
  const fields = fieldNamesOf(modelBody('MfaRecoveryCode'));

  it('has the hash column', () => {
    expect(fields).toContain('codeHash');
  });

  /**
   * The claim this test exists to pin: a ten-character recovery code is shown once, in the response
   * body of `confirm` or of `regenerate`, and reaches the database only as an Argon2id hash. A column
   * that stored the plaintext — `code`, `plainCode`, `recoveryCode` — would silently turn "shown once"
   * into "readable from a database dump forever", and nothing about the application code would look
   * wrong: the use-cases already return the plaintext to the caller once, so a repository quietly
   * also persisting it would not fail a single existing test.
   */
  it.each(['code', 'plainCode', 'plaintextCode', 'recoveryCode'])(
    'has no "%s" column alongside the hash',
    (plaintextField) => {
      expect(fields).not.toContain(plaintextField);
    },
  );
});

describe('the TOTP secret column stays encrypted-only', () => {
  const fields = fieldNamesOf(modelBody('User'));

  it('has the encrypted column', () => {
    expect(fields).toContain('totpSecretEnc');
  });

  it.each(['totpSecret', 'totpSecretPlain', 'totpBase32Secret'])(
    'has no "%s" column carrying the secret unencrypted',
    (plaintextField) => {
      expect(fields).not.toContain(plaintextField);
    },
  );
});

describe('the negative control: neither secret ever reaches the logger unredacted', () => {
  /**
   * Not a duplicate of `logging/redaction.test.ts` — that file proves the redaction *mechanism*
   * against the generic key names in `CLAUDE.md`. This is the cross-check that the **domain-specific**
   * names this feature actually uses (`base32Secret`, `secretEnc`, `recoveryCodes`) are declared in
   * that same list, which is the fact `SetupTotpUseCase`, `ConfirmTotpUseCase` and
   * `RegenerateRecoveryCodesUseCase` all depend on being true without re-checking it themselves.
   */
  it.each(['base32Secret', 'secretEnc', 'recoveryCodes'])(
    'declares "%s" in the redaction path list, nested and at the top level',
    (field) => {
      expect(REDACTED_PATHS).toContain(`*.${field}`);
      expect(REDACTED_PATHS).toContain(field);
    },
  );
});
