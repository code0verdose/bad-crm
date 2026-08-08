/**
 * The page is imported from **its own module**, not from the `@pages` barrel — the barrel re-exports
 * every page, so one import would pull all of them into the chunk the entry preloads (STORY-012-03).
 */
import { createFileRoute } from '@tanstack/react-router';

import { AdminMembersPage } from '@pages/admin-members';
import { EmployeeModel } from '@units/employee';
import { IamService } from '@units/iam';

/**
 * `/admin/members` — wiring only (`rules/frontend-fsd.mdc` rule 10).
 *
 * The search schema is the screen's state, validated here so that a hand-edited URL cannot reach a
 * component: an unknown status, a page that is a word, an order that is not one — each falls back to
 * its default inside the schema rather than replacing the screen with an error boundary. The server
 * does the opposite and answers 422, because there an unknown value means a client sent it.
 *
 * The guard is `user:read` — the directory is a list of **other** people, unlike `$userId`, which a
 * person may open on themselves and therefore carries no guard at all.
 */
export const Route = createFileRoute('/_authenticated/admin/members/')({
  beforeLoad: IamService.IamGuards.requirePermission('user:read'),
  validateSearch: EmployeeModel.memberListSearchSchema,
  component: AdminMembersPage,
  staticData: { crumbKey: 'members.title' },
});
