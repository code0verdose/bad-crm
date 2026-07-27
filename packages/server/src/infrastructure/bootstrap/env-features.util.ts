import { SECRET_BEARING_ENV_KEYS, insecureMarkerIn, type ServerEnv } from './env.schema.js';

/** A feature that is running in reduced form because its optional service is not configured. */
export interface Degradation {
  readonly feature: 'search' | 'mail' | 'ai' | 'tracing';
  readonly fallback: string;
}

/**
 * What this installation is *not* doing, in the order the startup summary prints it.
 *
 * The application is required to start without Meilisearch, without SMTP, without AI and without
 * an OTel collector (stack.md, «Деградация при отсутствии опционального сервиса»). Since it starts
 * anyway, the only way an operator learns that search is running on PostgreSQL FTS is this line —
 * silence would be indistinguishable from a fully configured instance.
 */
export const describeDegradations = (env: ServerEnv): Degradation[] => {
  const degradations: Degradation[] = [];

  if (env.MEILI_HOST === undefined) {
    degradations.push({ feature: 'search', fallback: 'postgres-fts' });
  }
  if (env.SMTP_URL === undefined) {
    degradations.push({ feature: 'mail', fallback: 'log' });
  }
  if (!env.AI_ENABLED) {
    degradations.push({ feature: 'ai', fallback: 'disabled' });
  }
  if (env.OTEL_EXPORTER_OTLP_ENDPOINT === undefined) {
    degradations.push({ feature: 'tracing', fallback: 'disabled' });
  }

  return degradations;
};

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
