import { SECRET_BEARING_ENV_KEYS, insecureMarkerIn, type ServerEnv } from './env.schema.js';

/** A feature that is not running in full because the service behind it is not configured. */
interface DegradedFeature {
  readonly feature: 'authentication' | 'search' | 'mail' | 'ai' | 'tracing';
  readonly fallback: string;
}

/**
 * A degradation, split by whether the fallback is a reduced form of the feature or its absence.
 *
 * Search on PostgreSQL FTS is a worse search; authentication without `DATABASE_AUTH_URL` is no
 * authentication at all, and the difference has to be visible in the log rather than inferred from
 * a `fallback` string. A blocking one is written on its own line at `warn` before the port opens,
 * because an operator scanning a startup log for problems reads the levels — not the fields of the
 * line that says the process is listening.
 *
 * A union rather than a boolean flag, so that "blocking implies there is something to do about it"
 * is a fact the compiler holds: a blocking degradation cannot be constructed without its `remedy`.
 */
export type Degradation =
  | (DegradedFeature & { readonly blocking: false })
  | (DegradedFeature & { readonly blocking: true; readonly remedy: string });

/**
 * What this installation is *not* doing, in the order the startup summary prints it.
 *
 * The application is required to start without Meilisearch, without SMTP, without AI and without
 * an OTel collector (stack.md, «Деградация при отсутствии опционального сервиса»). Since it starts
 * anyway, the only way an operator learns that search is running on PostgreSQL FTS is this line —
 * silence would be indistinguishable from a fully configured instance.
 *
 * Authentication is in the list for the opposite reason. It is not optional and never was: the
 * moment the sign-in routes entered the router, `DATABASE_AUTH_URL` became required in meaning
 * while staying `.optional()` in the schema, because turning a variable into a hard requirement
 * stops every existing installation from starting (`rules/self-host-packaging.mdc`, rule 2 —
 * release N warns, release N+1 refuses). This line *is* the warning that rule asks for. Without it
 * the container is green, `/ready` says nothing, and the first person to sign in is the monitoring.
 */
export const describeDegradations = (env: ServerEnv): Degradation[] => {
  const degradations: Degradation[] = [];

  if (env.DATABASE_AUTH_URL === undefined) {
    degradations.push({
      feature: 'authentication',
      fallback: 'unavailable',
      blocking: true,
      remedy:
        'Set DATABASE_AUTH_URL to the app_auth connection string, or nobody on this installation can sign in (docs/runbooks/install.md).',
    });
  }
  if (env.MEILI_HOST === undefined) {
    degradations.push({ feature: 'search', fallback: 'postgres-fts', blocking: false });
  }
  if (env.SMTP_URL === undefined) {
    // Not `log`. The label used to say that, and it described a behaviour the mail adapter must
    // never have: the one letter the authentication core sends carries a single-use reset token
    // inside its link, and writing that letter at `info` hands password reset to everyone who
    // reads the logs. Without SMTP the operation answers 503 `mail_not_configured` and nothing is
    // written — `rules/observability.mdc`, «Что нельзя логировать никогда».
    degradations.push({ feature: 'mail', fallback: 'unavailable', blocking: false });
  } else if (env.MAIL_FROM === undefined) {
    // Configured in name only. A relay that checks the envelope refuses every message without a
    // sender, so this installation would answer «sent» to nothing. It is the warning half of
    // `rules/self-host-packaging.mdc` rule 2: the release that wires the mailer into the container
    // turns it into a refusal, and until then an existing installation still starts.
    degradations.push({
      feature: 'mail',
      fallback: 'unavailable',
      blocking: true,
      remedy:
        'SMTP_URL is set but MAIL_FROM is not: a relay that checks the envelope sender rejects every message. Set MAIL_FROM to the address this installation sends from (docs/runbooks/install.md).',
    });
  }
  if (!env.AI_ENABLED) {
    degradations.push({ feature: 'ai', fallback: 'disabled', blocking: false });
  }
  if (env.OTEL_EXPORTER_OTLP_ENDPOINT === undefined) {
    degradations.push({ feature: 'tracing', fallback: 'disabled', blocking: false });
  }

  return degradations;
};

/**
 * The degradations that deserve a `warn` line of their own at startup.
 *
 * Separate from the summary rather than a filter written at the call site, so "which absences are
 * serious" is stated once, next to the list that produces them.
 */
export const blockingDegradationWarnings = (env: ServerEnv): string[] =>
  describeDegradations(env).flatMap((degradation) =>
    degradation.blocking
      ? [`${degradation.feature} is ${degradation.fallback}. ${degradation.remedy}`]
      : [],
  );

/**
 * Secrets still holding a `.env.example` placeholder or a compose dev fallback.
 *
 * In production the same condition is a hard parse failure (`env.schema.ts`); here it produces a
 * warning, because a developer laptop legitimately runs on `dev_postgres_password`. The warning
 * exists so that the day a laptop configuration is copied onto a server, the log already said so.
 */
export const insecureDefaultWarnings = (env: ServerEnv): string[] =>
  SECRET_BEARING_ENV_KEYS.flatMap((key) => {
    const marker = insecureMarkerIn(env[key]);

    return marker === undefined
      ? []
      : [
          `${key} still contains the development placeholder "${marker}" — safe on a laptop, unusable on a server. Generate a real secret: openssl rand -base64 32`,
        ];
  });
