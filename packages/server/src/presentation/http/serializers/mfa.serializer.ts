import { type RecoveryCodeCounts } from '@/application/identity/ports/recovery-code-repository.port.js';
import { type SetupTotpResult } from '@/application/identity/use-cases/setup-totp.use-case.js';

/**
 * Use-case results → the schemas of `docs/api/openapi.yaml`.
 *
 * `serializeTotpSetup` and `serializeRecoveryCodes` are each reachable from exactly one controller
 * call, ever, in the lifetime of one enrolment — the point of the whole design (STORY-013-01,
 * acceptance 7; STORY-013-02, acceptance 2). Neither the base32 secret nor a plaintext recovery code
 * is a field any other serializer in this codebase produces.
 */

export interface TotpSetupResponse {
  readonly secret: string;
  readonly uri: string;
  readonly qrSvg: string;
}

export interface RecoveryCodesIssuedResponse {
  readonly codes: readonly string[];
}

export interface RecoveryCodesStatusResponse {
  readonly total: number;
  readonly remaining: number;
}

export const serializeTotpSetup = (result: SetupTotpResult): TotpSetupResponse => ({
  secret: result.base32Secret,
  uri: result.uri,
  qrSvg: result.qrSvg,
});

export const serializeRecoveryCodesIssued = (
  codes: readonly string[],
): RecoveryCodesIssuedResponse => ({ codes: [...codes] });

export const serializeRecoveryCodesStatus = (
  counts: RecoveryCodeCounts,
): RecoveryCodesStatusResponse => ({ total: counts.total, remaining: counts.remaining });
