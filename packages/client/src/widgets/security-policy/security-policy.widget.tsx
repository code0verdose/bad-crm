import { Stack } from '@mantine/core';

import { SharedUi } from '@shared';

import { type OrganizationModel, OrganizationService } from '@units/organization';

import { MfaCoveragePanel } from './ui/mfa-coverage-panel.component.js';
import { PolicyForm } from './ui/policy-form.component.js';

export interface SecurityPolicyProps {
  readonly search: OrganizationModel.OrganizationSettingsSearch;
  readonly navigate: OrganizationService.OrganizationHooks.CoverageSearchNavigation;
  /** The moment a deadline is measured from. A parameter so a test can state one. */
  readonly now: Date;
}

/**
 * The security tab of `/admin/organization`: the policy, and who it reaches.
 *
 * Two sections rather than one screen, because they answer different questions and fail
 * independently — the editor needs the stored policy, the report needs every account — and a single
 * `DataState` over both would hide a working half behind the other's error.
 *
 * **The form is mounted only once the policy has arrived**, and that is what lets the editor seed its
 * draft from a value instead of watching a query with an effect (`rules/frontend-fsd.mdc` rule 11).
 * There is no «policy not known yet» state to draft against, so there is none to represent.
 */
export function SecurityPolicy({ search, navigate, now }: SecurityPolicyProps) {
  const policy = OrganizationService.OrganizationHooks.useSecurityPolicy();

  return (
    <Stack gap="xl">
      <SharedUi.Section
        descriptionKey="organization.security.description"
        titleKey="organization.security.title"
      >
        <SharedUi.DataState
          errorMessageKey="organization.security.loadFailed"
          onRetry={policy.refetch}
          skeleton={<SharedUi.TextSkeleton lines={4} />}
          status={policy.status}
        >
          {policy.policy !== undefined && <PolicyForm policy={policy.policy} />}
        </SharedUi.DataState>
      </SharedUi.Section>

      <SharedUi.Section
        descriptionKey="organization.security.coverage.description"
        titleKey="organization.security.coverage.title"
      >
        <MfaCoveragePanel navigate={navigate} now={now} search={search} />
      </SharedUi.Section>
    </Stack>
  );
}
