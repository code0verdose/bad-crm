import { type SharedPermissions } from '@bad-crm/shared';

import { type ProjectRole } from '@/domain/access/implicit-level.policy.js';

/**
 * One active account of the organization and their live seat on the project — or `null` when
 * they are not on it.
 */
export interface ProjectSeatFacts {
  readonly userId: string;
  readonly memberRole: ProjectRole | null;
}

/**
 * One live grant on the project's chain that reaches one active account — through the account
 * itself, a role it holds or a team it is on. The shape of `AclEntryOnChain`, tagged with whom it
 * reached: depth `0` is the project node, `1` the organization node.
 */
export interface ProjectGrantFacts {
  readonly userId: string;
  readonly depth: number;
  readonly level: SharedPermissions.AccessLevel;
  readonly expiresAt: Date | null;
}

/**
 * The facts «who in this organization reads the project» is decided from, for **everybody at once**
 * — the read behind the summary of a visibility change (STORY-014-01, acceptance 7).
 *
 * The per-person readers answer the same questions one account at a time
 * (`ProjectAccessReaderPort.aclFacts`, `AclReaderPort.entriesAlong`); asked for every colleague they
 * would cost two statements a head. This one answers for the organization in two — a constant,
 * independent of its size, while the rows read are O(N) in its accounts — and the
 * integration suite (`test/integration/db/project-visibility-impact.test.ts`) holds its answer equal
 * to the per-person read decision, colleague by colleague, on a live database.
 *
 * **Who is in the audience is decided here: active, undeleted accounts.** A suspended account has
 * no session and an invited one has never signed in; neither reads anything, whatever the chain
 * says, and a summary that counted them would warn about access nobody has.
 *
 * Facts only, like every access reader (`test/unit/architecture/access-readers.test.ts`): ids,
 * roles, levels — no names, no addresses. No `organizationId` parameter: the tenant is the scope the
 * caller opened.
 */
export interface ProjectAudienceAccessReaderPort {
  /** Every active account, with its live seat on the project (`null` — not on it). */
  seatsOf(projectId: string): Promise<readonly ProjectSeatFacts[]>;
  /** Every live grant on `PROJECT → ORGANIZATION` that reaches an active account, unreduced. */
  grantsOn(projectId: string): Promise<readonly ProjectGrantFacts[]>;
}
