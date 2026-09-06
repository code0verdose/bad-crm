import { SharedAudit } from '@bad-crm/shared';

/**
 * Whether an action may take effect without its audit row — STORY-016-02, acceptance 9.
 *
 * Two conditions, both on the **action** and never on the call site: the severity is `INFO`
 * (`AUDIT_ACTION_SEVERITY`) **and** no key the action stands behind is one the permission catalogue
 * marks `dangerous` (`AUDIT_ACTION_PERMISSIONS`, joined to `PERMISSION_META`). `WARNING` and
 * `CRITICAL` never degrade; an `INFO` entry that records the exercise of a dangerous key does not
 * either.
 *
 * The second condition was missing from the first draft, and the catalogue had the counter-example
 * on the day it shipped: `permission.inspected` is `INFO` — a read grants nothing, so it is not an
 * alarm — but it is the only trace of `permission:override_read`, which the catalogue calls
 * dangerous because «a read nobody is told about is how the write gets planned». Letting that read
 * succeed with no row when the insert fails is the write getting planned unobserved, and the
 * compensating control of STORY-011-11 would have been true only on the days the database was
 * healthy. Severity says how loudly an entry reads; the flag says whether its absence may be
 * tolerated, and the two are different questions.
 *
 * The reasoning for the rest is the story's — a privileged action with no record of it is worse
 * than the action not happening, while a sign-in that left no row is a hole an operator is told
 * about and can live with.
 *
 * One function rather than two comparisons, because two places have to agree on it and cannot be
 * allowed to drift: the adapter fences an insert in a savepoint only for the actions listed here
 * (`audit-log.adapter.ts`), and the decorator swallows a failure only for the same ones
 * (`degrading-audit-logger.adapter.ts`). A savepoint without the swallow is two round trips for
 * nothing; a swallow without the savepoint is a success the transaction contradicts at commit.
 */
export const isDegradableAuditAction = (action: SharedAudit.AuditAction): boolean =>
  SharedAudit.severityOf(action) === 'INFO' && !SharedAudit.isBehindDangerousPermission(action);
