import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { type FieldEncryptionPort } from '@/application/platform/ports/field-encryption.port.js';

/**
 * AES-256-GCM under `APP_ENCRYPTION_KEY`, in the format `v1:<iv>:<tag>:<ciphertext>`.
 *
 * **GCM rather than CBC**, so the stored value carries its own integrity tag: a row somebody edited
 * in the database fails to decrypt instead of decrypting to something else. That matters more here
 * than speed — the field is read once per screen, and a silently altered emergency contact is a
 * phone call to the wrong person.
 *
 * **A fresh 12-byte IV per encryption, from the CSPRNG.** GCM's security collapses entirely if an
 * IV repeats under the same key, which is why it is generated here rather than derived from
 * anything about the row: a deterministic IV would repeat the moment the same value is written
 * twice, and the two ciphertexts together leak the plaintext.
 *
 * Twelve bytes, not sixteen: 96 bits is the size GCM is specified for, and any other length sends
 * the IV through GHASH first — legal, slower, and outside the analysis everybody has read.
 */
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const VERSION = 'v1';

export class AesFieldEncryption implements FieldEncryptionPort {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, 'base64');

    // Checked at construction, which happens once at start-up: a 24-byte key would otherwise throw
    // on the first person who fills in an emergency contact, months later, in a request that looks
    // unrelated. `env.schema.ts` already refuses the wrong length; this is the second wall, because
    // the class is also constructed by tests and by any future caller.
    if (this.key.byteLength !== 32) {
      throw new Error(
        `APP_ENCRYPTION_KEY must decode to 32 bytes for ${ALGORITHM}, got ${String(this.key.byteLength)}`,
      );
    }
  }

  encrypt(plaintext: string | null): string | null {
    if (plaintext === null) return null;

    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

    return [
      VERSION,
      iv.toString('base64'),
      cipher.getAuthTag().toString('base64'),
      ciphertext.toString('base64'),
    ].join(':');
  }

  decrypt(ciphertext: string | null): string | null {
    if (ciphertext === null) return null;

    const [version, iv, tag, payload] = ciphertext.split(':');

    // A stored value this key cannot read is not «no value»: folding the two together turns a lost
    // key or a truncated column into an empty field nobody investigates.
    if (version !== VERSION || iv === undefined || tag === undefined || payload === undefined) {
      throw new Error(`encrypted field is not in the ${VERSION} format this key reads`);
    }

    const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(iv, 'base64'));

    decipher.setAuthTag(Buffer.from(tag, 'base64'));

    return Buffer.concat([
      decipher.update(Buffer.from(payload, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }
}
