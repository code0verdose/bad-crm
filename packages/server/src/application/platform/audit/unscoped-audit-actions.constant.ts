import { type SharedAudit } from '@bad-crm/shared';

/**
 * The actions that may be recorded without an organization — the whole list, and nothing else.
 *
 * `audit_logs.organization_id` is `NOT NULL`, so an event with no organization cannot be a row and
 * has to go somewhere else: today a log line, which is rotated, unindexed and outside the
 * append-only guarantees of the table. That sink is legitimate for the events below and for no
 * others, which is why this is a list rather than the structural condition it replaces.
 *
 * **Why the condition had to go.** `PrismaAuditLogger` used to decide by circumstance: no ambient
 * tenant scope, no `actor.organizationId`, or an actor disagreeing with the scope. None of the three
 * names an action, so all of them cover every action — a use-case whose caller drifted out of the
 * ambient scope kept working, returned success, and left its privileged action as a log line nobody
 * asked for. The trail promises the opposite (`audit-logger.port.ts`: an action nobody could write
 * down did not happen), and a promise that degrades quietly is the failure mode the audit trail
 * exists to not have. Everything not listed here is now refused, and the refusal reaches the caller.
 *
 * ## What is on the list, and why
 *
 * - **`rls.bypassed`** — a path that steps around row level security: a support tool, a cross-tenant
 *   job, a migration. It is the one action whose *definition* is «outside a tenant», so demanding a
 *   tenant scope of it would be demanding the thing it exists to report the absence of. It has no
 *   call site yet (`test/unit/audit/audit-coverage.test.ts` records that as deliberate), so this
 *   entry is the trail being ready before the capability rather than after.
 *
 * ## What was considered and left off
 *
 * - **`organization.registered`** — the docstrings around the sink used to claim registration
 *   happens «before any organization is known». It does not: `register-organization.use-case.ts`
 *   records it inside the `withTenant` that *creates* the organization
 *   (`BootstrapOrganizationUseCase.inSameTransaction`), so the row commits with the tenant or not
 *   at all. Listing it would excuse a real hole in the one event an operator can least afford to
 *   find missing.
 * - **`session.signed_in`** — offered as «a refused sign-in has no tenant yet». There is no audit
 *   action for a refused sign-in: `AUDIT_ACTIONS` records what happened, refusals are logged and
 *   rate-limited instead. A successful sign-in always resolved an account, so it always has an
 *   organization.
 * - **`password.reset`, `invitation.accepted`** — both act on an account that already belongs to an
 *   organization; the token resolves it before anything is written.
 *
 * A new entry is added here in the pull request that introduces the path needing it, with the reason
 * written down — not by a caller discovering at runtime that the guard is in the way.
 */
export const AUDIT_ACTIONS_WITHOUT_ORGANIZATION: ReadonlySet<SharedAudit.AuditAction> =
  new Set<SharedAudit.AuditAction>(['rls.bypassed']);
