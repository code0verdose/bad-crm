import { createHmac } from 'node:crypto';

/**
 * A TOTP code, computed from a base32 secret independently of any TOTP library.
 *
 * `packages/e2e` may not import product sources (`playwright.config.ts`: «drives the running stack
 * over HTTP and the browser, and knows nothing of their sources»), so this cannot call
 * `OtplibTotpAdapter`. Reaching for `otplib` itself would fix that only by adding a dependency
 * nothing else in this package needs, for six digits a dozen lines of `node:crypto` already produce
 * — and it would trade one library's correctness for trusting the same library twice, on both sides
 * of the assertion. `packages/server/test/unit/crypto/otplib-totp.adapter.test.ts` makes the same
 * choice for the same reason: it checks the server's adapter against values computed from scratch,
 * not against `otplib`'s own idea of the answer.
 *
 * RFC 4226 §5.3 (HOTP: HMAC-SHA1, dynamic truncation, `% 10**digits`) and RFC 6238 §4 (TOTP: the
 * counter is `floor(unixTime / step)`) — plain, unauthenticated public standards, not a secret to
 * protect. Before being trusted here, this implementation was run against the RFC 6238 Appendix B
 * test vectors (the same five `(epoch, code)` pairs `otplib-totp.adapter.test.ts` checks the server
 * against) and reproduced every one of them; see the story's e2e checklist for the command.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 (no padding), the alphabet `otplib` and every authenticator app use for secrets. */
const decodeBase32 = (input: string): Buffer => {
  const clean = input.toUpperCase().replace(/=+$/u, '');
  let bits = '';

  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);

    if (index === -1) {
      throw new Error(`not a base32 character: ${char}`);
    }

    bits += index.toString(2).padStart(5, '0');
  }

  const bytes: number[] = [];

  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }

  return Buffer.from(bytes);
};

/** RFC 4226 §5.3: HMAC-SHA1 over the 8-byte big-endian counter, then dynamic truncation. */
const hotp = (secret: Buffer, counter: number, digits: number): string => {
  const counterBuffer = Buffer.alloc(8);

  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const mac = createHmac('sha1', secret).update(counterBuffer).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const truncated =
    (((mac[offset] ?? 0) & 0x7f) << 24) |
    (((mac[offset + 1] ?? 0) & 0xff) << 16) |
    (((mac[offset + 2] ?? 0) & 0xff) << 8) |
    ((mac[offset + 3] ?? 0) & 0xff);

  return (truncated % 10 ** digits).toString().padStart(digits, '0');
};

/**
 * The code the server accepts right now for `base32Secret`.
 *
 * Fixed at `TOTP_STEP_SECONDS = 30` and six digits — the parameters STORY-013-01's own
 * `otpauth://` URI advertises (`algorithm=SHA1&digits=6&period=30`) and the only ones this
 * installation issues. The server's drift window is ±1 step either side, so a few seconds between
 * this call and the request reaching the server does not make the code stale.
 */
export const currentTotpCode = (base32Secret: string, at: Date = new Date()): string => {
  const counter = Math.floor(at.getTime() / 1000 / 30);

  return hotp(decodeBase32(base32Secret), counter, 6);
};
