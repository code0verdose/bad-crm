import { type AccessTokenPort } from '@/application/identity/ports/access-token.port.js';
import { type AddressHasherPort } from '@/application/identity/ports/address-hasher.port.js';
import {
  type MintedRefreshToken,
  type RefreshTokenPort,
} from '@/application/identity/ports/refresh-token.port.js';
import {
  type CreatedSession,
  type SessionDraft,
  type SessionRepositoryPort,
} from '@/application/identity/ports/session-repository.port.js';
import { type OrganizationRepositoryPort } from '@/application/organization/ports/organization-repository.port.js';
import {
  type MfaGateVerdict,
  type MfaPolicyQuery,
} from '@/application/organization/use-cases/mfa-policy.query.js';
import { type TotpEnrollmentRepositoryPort } from '@/application/identity/ports/totp-enrollment.port.js';
import { type ClockPort } from '@/application/platform/ports/clock.port.js';
import { type IdGeneratorPort } from '@/application/platform/ports/id-generator.port.js';
import { maskIpAddress } from '@/domain/identity/mask-ip-address.util.js';

/** Thirty days, as `docs/api/openapi.yaml` publishes the cookie's `Max-Age`. */
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * How many times a colliding refresh digest is re-minted before the request is given up on.
 *
 * Three, and the number is irrelevant: with 256 bits of entropy the first attempt collides with
 * probability far below that of the disk lying. What matters is that the loop is bounded and that
 * running out is an internal error rather than a client-visible conflict.
 */
const REFRESH_TOKEN_MINT_ATTEMPTS = 3;

/** What the transport knows about the caller's machine, and all of it. */
export interface SessionClient {
  readonly userAgent: string;
  /** The peer address as the deployment reports it; `undefined` when there is none to report. */
  readonly ipAddress: string | undefined;
}

export interface IssueSessionInput {
  readonly userId: string;
  readonly permissionsVersion: number;
  readonly client: SessionClient;
  /**
   * The family to continue. Absent on a sign-in, which starts one; present on a rotation, which
   * keeps the device the family stands for.
   */
  readonly familyId?: string;
  readonly rotatedFromId?: string;
}

export interface IssuedSession {
  readonly sessionId: string;
  /**
   * The session may enrol a second factor and sign out, and nothing else (acceptance 3).
   *
   * Returned as well as signed into the token so that the sign-in response can say so without the
   * client decoding a JWT it has no business reading — the same reasoning `LoginResult` gives for
   * carrying `expiresInSeconds` beside `mfaToken`.
   */
  readonly mfaEnrollment: boolean;
  /**
   * When the caller's grace period ends, for the countdown banner of acceptance 4.
   *
   * `undefined` when the organization's policy covers none of their roles — which is every session
   * of every installation that has not switched the policy on, i.e. the default.
   */
  readonly mfaGraceEndsAt: Date | undefined;
  readonly familyId: string;
  readonly accessToken: string;
  readonly expiresInSeconds: number;
  /** The opaque secret, for `Set-Cookie` and for nothing else. */
  readonly refreshToken: string;
  readonly refreshExpiresAt: Date;
}

/**
 * Writes one session row and mints the pair of tokens that address it.
 *
 * **It does not open a transaction, and that is deliberate.** Every caller already has a reason to
 * own one: registration writes the organization first, sign-in may re-hash the password in the same
 * breath, and rotation *must* spend the old token and write the new row atomically or a race mints
 * two live sessions from one credential. So the scope belongs to the caller, and this runs inside
 * it — the repositories find the transaction through `withTenant` on their own
 * (`tenant-scoped.repository.ts`).
 *
 * The order is: row first, tokens second. `sid` is the primary key of the row, so the JWT cannot be
 * minted before the insert — and minting it afterwards means a failed insert produces no token at
 * all rather than a token naming a session that does not exist.
 */
export class IssueSessionUseCase {
  constructor(
    private readonly sessions: SessionRepositoryPort,
    private readonly organizations: OrganizationRepositoryPort,
    private readonly refreshTokens: RefreshTokenPort,
    private readonly accessTokens: AccessTokenPort,
    private readonly addresses: AddressHasherPort,
    private readonly clock: ClockPort,
    private readonly ids: IdGeneratorPort,
    private readonly enrollment: TotpEnrollmentRepositoryPort,
    private readonly policies: MfaPolicyQuery,
  ) {}

  async execute(input: IssueSessionInput): Promise<IssuedSession> {
    const now = this.clock.now();
    const familyId = input.familyId ?? this.ids.uuid();
    const expiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000);

    const minted = await this.insertWithFreshToken({
      userId: input.userId,
      familyId,
      rotatedFromId: input.rotatedFromId ?? null,
      userAgent: input.client.userAgent,
      ipHash: this.addresses.hash(input.client.ipAddress),
      // Masked here, before the row is written, because the other address column is a keyed digest
      // and no function turns a digest back into something a screen can show
      // (`data-model.md`, «Про адрес сессии»). The full address is stored nowhere.
      ipMasked: maskIpAddress(input.client.ipAddress),
      expiresAt,
    });

    const { created, refresh } = minted;

    // The one place the organization's second-factor policy decides anything about a session, and
    // therefore the one place every path that opens one — sign-in, the second-factor step, a
    // refresh, accepting an invitation, registering — is covered by the same decision. A branch in
    // each caller would be five branches, and the fifth would be the one somebody forgot.
    const verdict = await this.gate(input.userId);

    const access = await this.accessTokens.issue({
      userId: input.userId,
      organizationId: await this.organizationOf(),
      sessionId: created.id,
      permissionsVersion: input.permissionsVersion,
      mfaEnrollment: verdict.gate === 'enrollment_required',
    });

    return {
      sessionId: created.id,
      familyId,
      accessToken: access.token,
      expiresInSeconds: access.expiresInSeconds,
      refreshToken: refresh.token,
      refreshExpiresAt: expiresAt,
      mfaEnrollment: verdict.gate === 'enrollment_required',
      mfaGraceEndsAt: verdict.covered ? verdict.graceEndsAt : undefined,
    };
  }

  /**
   * What the organization's policy says about the account this session belongs to.
   *
   * Two statements — the tenant root's `settings`, and the account's unexpired role grants — plus
   * the enrolment row, which is a third. They run **once per session issue**, which on a live
   * installation means once per sign-in and once per refresh (every fifteen minutes per session),
   * not once per request: nothing on the hot path grew. The alternative, a guard that re-decided per
   * request, would have added all three to every request of every organization — including the ones
   * with no policy, which is all of them by default.
   */
  private async gate(userId: string): Promise<MfaGateVerdict> {
    const enrolled = await this.enrollment.find(userId);

    return this.policies.gateFor({
      userId,
      hasSecondFactor: enrolled !== null && enrolled.enabledAt !== null,
    });
  }

  /**
   * Writes the row, minting another token if the digest was already taken.
   *
   * The collision cannot realistically happen — thirty-two CSPRNG bytes — and the loop exists
   * because of what would happen if it did. `uq_sessions_refresh_hash` is **global**: a `23505`
   * escaping to the client would be an answer about a row in some other organization, and a `409`
   * on sign-in would be a cross-tenant oracle with a very small but non-zero probability. So the
   * only observable outcome is the ordinary one, and an exhausted loop is an internal error with no
   * code of its own rather than a conflict.
   */
  private async insertWithFreshToken(
    draft: Omit<SessionDraft, 'refreshTokenHash'>,
  ): Promise<{ created: CreatedSession; refresh: MintedRefreshToken }> {
    for (let attempt = 0; attempt < REFRESH_TOKEN_MINT_ATTEMPTS; attempt += 1) {
      const refresh = this.refreshTokens.mint();
      // Sequential by nature: each attempt depends on the previous one having collided.
      const created = await this.sessions.create({ ...draft, refreshTokenHash: refresh.hash });

      if (created !== null) return { created, refresh };
    }

    throw new Error('issue-session: could not mint an unused refresh token');
  }

  /**
   * The organization of the scope this runs in.
   *
   * Read back from the tenant root rather than accepted as an argument: `org` is the claim every
   * later request is authorised against, and an argument would be a second source of truth for the
   * tenant next to the one the transaction is already pinned to. If the two ever disagreed, the
   * token would name one organization while the row lived in another.
   */
  private async organizationOf(): Promise<string> {
    const organization = await this.organizations.findCurrent();

    if (organization === null) {
      throw new Error('issue-session: the tenant scope names an organization that does not exist');
    }

    return organization.id;
  }
}
