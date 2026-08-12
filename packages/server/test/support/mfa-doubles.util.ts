import { randomUUID } from 'node:crypto';

import { type FieldEncryptionPort } from '@/application/platform/ports/field-encryption.port.js';
import { type QrCodePort } from '@/application/identity/ports/qr-code.port.js';
import {
  type MintedRecoveryCode,
  type RecoveryCodeGeneratorPort,
} from '@/application/identity/ports/recovery-code-generator.port.js';
import {
  type RecoveryCodeCandidate,
  type RecoveryCodeCounts,
  type RecoveryCodeRepositoryPort,
} from '@/application/identity/ports/recovery-code-repository.port.js';
import {
  type TotpEnrollmentRepositoryPort,
  type TotpEnrollmentState,
} from '@/application/identity/ports/totp-enrollment.port.js';
import {
  type GeneratedTotpSecret,
  type TotpPort,
  type TotpVerification,
} from '@/application/identity/ports/totp.port.js';

/**
 * In-memory stand-ins for the 2FA ports (STORY-013-01, STORY-013-02) — the same reasoning
 * `identity-doubles.util.ts` states for the rest of the identity module: a use-case suite asserts
 * *decisions*, not calls, and the properties only a database can hold (the atomic consume race, RLS)
 * are asserted in `test/integration/db/**` instead.
 */

/**
 * A field-encryption double that is genuinely reversible — `Buffer.from(x).toString('base64url')`
 * and back — rather than a fixed string. A double that always returned the same "encrypted" value
 * regardless of input would let a use-case suite pass while comparing two different secrets as equal.
 */
export class FakeFieldEncryption implements FieldEncryptionPort {
  readonly encrypted: string[] = [];

  encrypt(plaintext: string | null): string | null {
    if (plaintext === null) return null;

    const value = `enc:${Buffer.from(plaintext, 'utf8').toString('base64url')}`;

    this.encrypted.push(value);

    return value;
  }

  decrypt(ciphertext: string | null): string | null {
    if (ciphertext === null) return null;

    if (!ciphertext.startsWith('enc:')) {
      throw new Error('FakeFieldEncryption.decrypt: not a value this double encrypted');
    }

    return Buffer.from(ciphertext.slice('enc:'.length), 'base64url').toString('utf8');
  }
}

export class FakeQrCode implements QrCodePort {
  readonly rendered: string[] = [];

  renderSvg(uri: string): Promise<string> {
    this.rendered.push(uri);

    return Promise.resolve(`<svg data-uri="${uri}"></svg>`);
  }
}

/**
 * A TOTP port whose `verify` is driven by a script rather than by real RFC 6238 math — the real
 * algorithm is asserted once, thoroughly, in `otplib-totp.adapter.test.ts`; what a use-case suite
 * needs is control over the answer, not a second implementation of HMAC-SHA1.
 */
export class ScriptedTotp implements TotpPort {
  readonly verifyCalls: { base32Secret: string; code: string; sinceCounter: number | null }[] = [];

  private secretCounter = 0;

  /** Queued answers, consumed in order by successive `verify` calls; the last one repeats. */
  script: TotpVerification[] = [{ accepted: true, counter: 1 }];

  generateSecret(email: string): GeneratedTotpSecret {
    this.secretCounter += 1;

    const base32Secret = `SECRET${String(this.secretCounter)}FOR${email.replace(/[^A-Z0-9]/gi, '')}`;

    return { base32Secret, uri: `otpauth://totp/BadCRM:${email}?secret=${base32Secret}` };
  }

  verify(input: {
    readonly base32Secret: string;
    readonly code: string;
    readonly at: Date;
    readonly sinceCounter: number | null;
  }): TotpVerification {
    this.verifyCalls.push({
      base32Secret: input.base32Secret,
      code: input.code,
      sinceCounter: input.sinceCounter,
    });

    // `replayed: false` and not a bare refusal: the port's result is a discriminated union so a
    // caller can tell «wrong code» from «code already spent», and a double that omitted the flag
    // would let a use-case forget to distinguish them and still compile.
    return (
      this.script[Math.min(this.verifyCalls.length - 1, this.script.length - 1)] ?? {
        accepted: false,
        replayed: false,
      }
    );
  }
}

interface StoredEnrollment {
  secretEnc: string | null;
  enabledAt: Date | null;
  draftExpiresAt: Date | null;
  lastCounter: number | null;
}

export class FakeTotpEnrollment implements TotpEnrollmentRepositoryPort {
  readonly rows = new Map<string, StoredEnrollment>();

  /** When true, every write behaves as if the account row could not be found (soft-deleted). */
  vanished = false;

  find(userId: string): Promise<TotpEnrollmentState | null> {
    const row = this.rows.get(userId);

    if (row === undefined || row.secretEnc === null) return Promise.resolve(null);

    return Promise.resolve({
      secretEnc: row.secretEnc,
      enabledAt: row.enabledAt,
      draftExpiresAt: row.draftExpiresAt,
      lastCounter: row.lastCounter,
    });
  }

  beginDraft(userId: string, secretEnc: string, draftExpiresAt: Date): Promise<boolean> {
    if (this.vanished) return Promise.resolve(false);

    const existing = this.rows.get(userId);

    if (existing?.enabledAt != null) return Promise.resolve(false);

    this.rows.set(userId, { secretEnc, enabledAt: null, draftExpiresAt, lastCounter: null });

    return Promise.resolve(true);
  }

  commitEnrollment(userId: string, counter: number, now: Date): Promise<boolean> {
    if (this.vanished) return Promise.resolve(false);

    const row = this.rows.get(userId);

    if (
      row === undefined ||
      row.enabledAt !== null ||
      row.draftExpiresAt === null ||
      row.draftExpiresAt.getTime() <= now.getTime()
    ) {
      return Promise.resolve(false);
    }

    row.enabledAt = now;
    row.draftExpiresAt = null;
    row.lastCounter = counter;

    return Promise.resolve(true);
  }

  advanceCounter(userId: string, counter: number): Promise<boolean> {
    const row = this.rows.get(userId);

    if (row === undefined || row.enabledAt === null) return Promise.resolve(false);
    if (row.lastCounter !== null && row.lastCounter >= counter) return Promise.resolve(false);

    row.lastCounter = counter;

    return Promise.resolve(true);
  }

  abandonDraft(userId: string): Promise<boolean> {
    const row = this.rows.get(userId);

    if (row === undefined || row.enabledAt !== null || row.secretEnc === null) {
      return Promise.resolve(false);
    }

    row.secretEnc = null;
    row.draftExpiresAt = null;
    row.lastCounter = null;

    return Promise.resolve(true);
  }
}

interface StoredRecoveryCode extends RecoveryCodeCandidate {
  readonly userId: string;
  usedAt: Date | null;
}

export class FakeRecoveryCodes implements RecoveryCodeRepositoryPort {
  readonly rows = new Map<string, StoredRecoveryCode>();

  createMany(userId: string, hashes: readonly string[]): Promise<void> {
    for (const codeHash of hashes) {
      const id = randomUUID();

      this.rows.set(id, { id, userId, codeHash, usedAt: null });
    }

    return Promise.resolve();
  }

  listUnused(userId: string): Promise<readonly RecoveryCodeCandidate[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter((row) => row.userId === userId && row.usedAt === null)
        .map((row) => ({ id: row.id, codeHash: row.codeHash })),
    );
  }

  markUsed(userId: string, id: string, now: Date): Promise<boolean> {
    const row = this.rows.get(id);

    if (row === undefined || row.userId !== userId || row.usedAt !== null) {
      return Promise.resolve(false);
    }

    row.usedAt = now;

    return Promise.resolve(true);
  }

  deleteAllForUser(userId: string): Promise<number> {
    const owned = [...this.rows.values()].filter((row) => row.userId === userId);

    for (const row of owned) this.rows.delete(row.id);

    return Promise.resolve(owned.length);
  }

  counts(userId: string): Promise<RecoveryCodeCounts> {
    const owned = [...this.rows.values()].filter((row) => row.userId === userId);

    return Promise.resolve({
      total: owned.length,
      remaining: owned.filter((row) => row.usedAt === null).length,
    });
  }
}

/** A generator that mints predictable, distinct codes — `code-1`, `code-2`, … — and reversible hashes. */
export class FakeRecoveryCodeGenerator implements RecoveryCodeGeneratorPort {
  private counter = 0;

  generateBatch(count: number): Promise<readonly MintedRecoveryCode[]> {
    const batch: MintedRecoveryCode[] = [];

    for (let index = 0; index < count; index += 1) {
      this.counter += 1;
      const plaintext = `CODE${String(this.counter).padStart(4, '0')}XX`;

      batch.push({ plaintext, hash: `hash:${plaintext}` });
    }

    return Promise.resolve(batch);
  }
}
