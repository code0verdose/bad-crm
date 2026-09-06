/**
 * The page is imported from **its own module**, not from the `@pages` barrel — the barrel re-exports
 * every page, so one import would pull all of them into the chunk the entry preloads (STORY-012-03).
 */
import { createFileRoute } from '@tanstack/react-router';

import { AdminOrganizationPage } from '@pages/admin-organization';
import { OrganizationModel } from '@units/organization';
import { IamService } from '@units/iam';

/**
 * `/admin/organization` — wiring only (`rules/frontend-fsd.mdc` rule 10).
 *
 * **The guard is `organization:manage_security_policy`, not the `organization:update` that
 * `ux-architecture.md` names for the finished screen** (STORY-013-05, acceptance 8). What is behind
 * this route today is the second-factor policy and the report of who has one — both gated on the
 * server by that dangerous capability — so guarding on the weaker key would admit somebody to a
 * screen whose every request answers 403. When the other four tabs of that document land, the route
 * takes `organization:update` and the security tab keeps this one.
 *
 * `'forbidden'` rather than `'not-found'`: `/admin/**` is in everybody's navigation, so the
 * section's existence is no secret and the refusal names what is missing
 * (`ux-architecture.md` → «403 vs 404»).
 *
 * The search schema is the screen's state — which tab, and how the coverage report is narrowed —
 * validated here so that a hand-edited URL cannot reach a component: an unknown tab, a status that
 * is not a status, a role list longer than a policy may name. Each falls back inside the schema
 * rather than replacing the screen with an error boundary; the server does the opposite and answers
 * 422, because there an unknown value means a client sent it.
 *
 * **No loader.** The screen reads two addresses and both are rendered behind `DataState`;
 * prefetching them in a loader would put the requests on the navigation's critical path to buy a
 * skeleton that is already handled.
 */
export const Route = createFileRoute('/_authenticated/admin/organization')({
  beforeLoad: IamService.IamGuards.requirePermission({
    permission: 'organization:manage_security_policy',
    whenDenied: 'forbidden',
  }),
  validateSearch: OrganizationModel.organizationSettingsSearchSchema,
  component: AdminOrganizationPage,
  staticData: { crumbKey: 'organization.title' },
});
