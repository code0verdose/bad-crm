import { type SharedPermissions } from '@bad-crm/shared';

/**
 * The label of each domain group, as an i18n key.
 *
 * A map rather than a template (`` `roles.domain.${domain}` ``): a key assembled at runtime is
 * invisible to the linter that forbids hardcoded strings and to the check that every key exists in
 * both languages, so the pseudo locale is the first thing that would notice a missing translation —
 * in a screenshot, after release.
 */
export const PERMISSION_DOMAIN_LABEL_KEY: Readonly<
  Record<SharedPermissions.PermissionDomain, string>
> = {
  organization: 'roles.domain.organization',
  iam: 'roles.domain.iam',
  project: 'roles.domain.project',
  task: 'roles.domain.task',
  knowledge: 'roles.domain.knowledge',
  file: 'roles.domain.file',
  vault: 'roles.domain.vault',
  'secure-link': 'roles.domain.secureLink',
  time: 'roles.domain.time',
  communication: 'roles.domain.communication',
  analytics: 'roles.domain.analytics',
  integration: 'roles.domain.integration',
  ai: 'roles.domain.ai',
  delivery: 'roles.domain.delivery',
  platform: 'roles.domain.platform',
};
