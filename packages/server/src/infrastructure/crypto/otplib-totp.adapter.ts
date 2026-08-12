import { generateSecret, NobleCryptoPlugin, ScureBase32Plugin } from 'otplib';
import { verifySync } from '@otplib/totp';

import {
  TOTP_CODE_DIGITS,
  TOTP_DRIFT_WINDOW_STEPS,
  TOTP_STEP_SECONDS,
  type GeneratedTotpSecret,
  type TotpPort,
  type TotpVerification,
} from '@/application/identity/ports/totp.port.js';

/** `otpauth://totp/BadCRM:{email}?...` — the issuer name every generated URI and QR code carries. */
const ISSUER = 'BadCRM';

/**
 * TOTP through `otplib` (v13, the `@otplib/*` core rewrite — `otpauth`/`otplib@12` and earlier are a
 * different, unmaintained lineage), with every RFC 6238 parameter stated explicitly rather than left
 * to the library's defaults.
 *
 * **`verify` goes straight to `@otplib/totp`, not to the top-level `otplib` wrapper.** The wrapper's
 * `verifySync` is typed to return `VerifyResult$totp | VerifyResult$hotp` — a union with the HOTP
 * strategy's result, which carries no `timeStep` — because its `strategy` option is runtime-optional
 * even though this adapter never passes anything but `'totp'`. Calling `@otplib/totp` directly is not
 * a workaround for that; it removes an option (`strategy: 'hotp'`) this adapter has no use for in the
 * first place, and gets back a result type where `timeStep` is unconditionally present on the `valid`
 * branch. The cost is stating the crypto and base32 plugins explicitly — `otplib`'s own wrapper
 * defaults them to `NobleCryptoPlugin` (`@noble/hashes` — audited, no native bindings) and
 * `ScureBase32Plugin`; this adapter imports the same two classes from the same top-level package and
 * constructs them once.
 *
 * **Synchronous throughout**, so `TotpPort` itself can stay synchronous: both plugins support the
 * `*Sync` entry points, and the one call whose validation can throw (`afterTimeStep` out of range) is
 * wrapped in a `try`/`catch` that answers `false`, matching `PasswordHasherPort.verify`'s promise of
 * "never throws".
 *
 * **`epochTolerance` in seconds, not "window in steps", is what `otplib` v13 exposes** — the adapter
 * converts `TOTP_DRIFT_WINDOW_STEPS` into it once, so the ±1-step contract `totp.port.ts` documents
 * is enforced by one multiplication rather than re-derived at each call site.
 */
export class OtplibTotpAdapter implements TotpPort {
  private readonly crypto = new NobleCryptoPlugin();
  private readonly base32 = new ScureBase32Plugin();

  generateSecret(email: string): GeneratedTotpSecret {
    // 20 bytes (the library default) = 160 bits, the floor STORY-013-01 acceptance 1 states by name.
    const base32Secret = generateSecret();

    return { base32Secret, uri: this.buildUri(base32Secret, email) };
  }

  /**
   * Built by hand rather than through `otplib`'s own `generateURI`.
   *
   * The library omits `algorithm`, `digits` and `period` from the query string whenever they equal
   * the RFC defaults (SHA-1, 6, 30) — a legitimate reading of the spec, and one every authenticator
   * app this product targets already assumes when those parameters are absent. STORY-013-01,
   * acceptance 1 states the URI shape with all three present by name, so this method writes them
   * explicitly instead of relying on a reader inferring the same defaults the library silently
   * applied.
   *
   * Only the account name is percent-encoded — `ISSUER:` stays literal, matching both the library's
   * own output for the label and the convention every reference implementation follows (a colon is a
   * valid path character per RFC 3986 `pchar`; the account name is not).
   */
  private buildUri(base32Secret: string, email: string): string {
    const params = new URLSearchParams({
      secret: base32Secret,
      issuer: ISSUER,
      algorithm: 'SHA1',
      digits: String(TOTP_CODE_DIGITS),
      period: String(TOTP_STEP_SECONDS),
    });

    return `otpauth://totp/${ISSUER}:${encodeURIComponent(email)}?${params.toString()}`;
  }

  verify(input: {
    readonly base32Secret: string;
    readonly code: string;
    readonly at: Date;
    readonly sinceCounter: number | null;
  }): TotpVerification {
    try {
      // `afterTimeStep` is deliberately **not** passed to the library. `@otplib/totp`'s own
      // `afterTimeStep` skips every candidate step at or before it while searching — the library
      // still tells the caller `{ valid: false }` for a step it never tried, indistinguishable from
      // a step it tried and rejected. That collapses exactly the two facts this adapter has to keep
      // apart: "these six digits never matched this secret at any accepted step" and "they matched,
      // at a step already spent". So the search runs unrestricted — every step in the tolerance
      // window is tried — and the comparison against `sinceCounter` happens here instead, on the
      // step the library actually found a match at.
      const result = verifySync({
        secret: input.base32Secret,
        token: input.code,
        crypto: this.crypto,
        base32: this.base32,
        algorithm: 'sha1',
        digits: TOTP_CODE_DIGITS,
        period: TOTP_STEP_SECONDS,
        epoch: Math.floor(input.at.getTime() / 1000),
        // Symmetric tolerance in seconds: ±1 step either side of the server's own time
        // (`TOTP_DRIFT_WINDOW_STEPS`), which is the contract `totp.port.ts` states and
        // `otplib-totp.adapter.spec.ts` pins with a 25-second-accepted / 90-second-refused pair.
        epochTolerance: TOTP_DRIFT_WINDOW_STEPS * TOTP_STEP_SECONDS,
      });

      if (!result.valid) return { accepted: false, replayed: false };

      const replayed = input.sinceCounter !== null && result.timeStep <= input.sinceCounter;

      if (replayed) return { accepted: false, replayed: true };

      return { accepted: true, counter: result.timeStep };
    } catch {
      // Reachable only from a malformed secret or token shape the validators upstream should already
      // have refused — is answered like every other refusal here: `false`, never a 500 on a
      // token-verification path.
      return { accepted: false, replayed: false };
    }
  }
}
