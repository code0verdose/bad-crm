import { type SessionListEntry } from '@/application/identity/use-cases/list-sessions.query.js';
import {
  type SessionOrganization,
  type SessionProfile,
} from '@/application/identity/use-cases/login.use-case.js';

/**
 * Use-case results → the schemas of `docs/api/openapi.yaml`.
 *
 * The one place the wire shape of the authentication surface is decided, which makes it the one
 * place that has to agree with the specification — and the one place to check that the refresh token
 * is not in it. **No function here takes one.** The opaque token travels from the use-case result
 * straight into `Set-Cookie` in the controller and is never handed to a serializer, so a body that
 * carries it cannot be written by accident (`docs/api/openapi.yaml`, «Two rules hold across the
 * whole group»).
 */

export interface AuthenticatedSessionResponse {
  readonly status: 'authenticated';
  readonly accessToken: string;
  readonly tokenType: 'Bearer';
  readonly expiresIn: number;
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly locale: string;
    readonly timezone: string;
  };
  readonly organization: {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
  };
}

export interface OrganizationSelectionResponse {
  readonly status: 'organization_selection_required';
  readonly organizations: readonly {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
  }[];
}

export interface SessionSummaryResponse {
  readonly id: string;
  readonly current: boolean;
  readonly device: string;
  readonly ipMasked: string;
  readonly createdAt: string;
  readonly lastUsedAt: string;
  readonly expiresAt: string;
}

export const serializeAuthenticatedSession = (input: {
  readonly accessToken: string;
  readonly expiresInSeconds: number;
  readonly user: SessionProfile;
  readonly organization: SessionOrganization;
}): AuthenticatedSessionResponse => ({
  status: 'authenticated',
  accessToken: input.accessToken,
  tokenType: 'Bearer',
  expiresIn: input.expiresInSeconds,
  user: {
    id: input.user.id,
    email: input.user.email,
    locale: input.user.locale,
    timezone: input.user.timezone,
  },
  organization: {
    id: input.organization.id,
    name: input.organization.name,
    slug: input.organization.slug,
  },
});

export const serializeOrganizationSelection = (
  organizations: readonly SessionOrganization[],
): OrganizationSelectionResponse => ({
  status: 'organization_selection_required',
  organizations: organizations.map((organization) => ({
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
  })),
});

/**
 * `Date` becomes an explicit ISO string here rather than being left to `JSON.stringify`, so the
 * format is a decision in the code and not a property of whichever serializer happens to run.
 */
export const serializeSessionList = (
  entries: readonly SessionListEntry[],
): { readonly items: SessionSummaryResponse[] } => ({
  items: entries.map((entry) => ({
    id: entry.id,
    current: entry.current,
    device: entry.device,
    ipMasked: entry.ipMasked,
    createdAt: entry.createdAt.toISOString(),
    lastUsedAt: entry.lastUsedAt.toISOString(),
    expiresAt: entry.expiresAt.toISOString(),
  })),
});

export const serializeRevokedCount = (revokedCount: number): { readonly revokedCount: number } => ({
  revokedCount,
});
