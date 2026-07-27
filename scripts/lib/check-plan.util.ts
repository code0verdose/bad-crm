import type { ServiceCheck } from './service-check.types.js';

/**
 * Which optional checks apply to this configuration, and why the others do not.
 *
 * "Skipped" has to be a first-class outcome rather than a silent absence: an operator on the
 * `minimal` profile must see that Meilisearch was not checked *and* that this is expected, not
 * wonder whether the script forgot about it.
 */

export type OptionalService = 'meilisearch' | 'smtp';

export interface ProfileContext {
  readonly meiliHost: string | undefined;
  readonly smtpUrl: string | undefined;
  /** `COMPOSE_PROFILES`, defaulting to what `pnpm docker:up` passes. */
  readonly profile: string;
}

/** Services `docker-compose.yml` declares with `profiles: ['default', 'full']`. */
const NOT_IN_MINIMAL: Record<OptionalService, string> = {
  meilisearch: 'meilisearch',
  smtp: 'mailpit',
};

const NOT_CONFIGURED: Record<OptionalService, string> = {
  meilisearch:
    'MEILI_HOST is not set — search runs on PostgreSQL full-text search instead (ADR-0011)',
  smtp: 'SMTP_URL is not set — outgoing mail is written to the log',
};

export const skipReasonFor = (
  service: OptionalService,
  context: ProfileContext,
): string | undefined => {
  const configured = service === 'meilisearch' ? context.meiliHost : context.smtpUrl;

  if (configured === undefined) return NOT_CONFIGURED[service];

  if (context.profile === 'minimal') {
    return `the minimal profile does not start ${NOT_IN_MINIMAL[service]}`;
  }

  return undefined;
};

export const skippedCheck = (service: string, target: string, reason: string): ServiceCheck => ({
  service,
  requirement: 'optional',
  target,
  run: () => Promise.resolve({ status: 'skipped', details: [reason] }),
});
