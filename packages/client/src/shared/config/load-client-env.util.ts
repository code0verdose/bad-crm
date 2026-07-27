import { clientEnvSchema, type ClientEnv } from './env.schema.js';

/**
 * Parses the browser configuration once, at module init of the application shell.
 *
 * The source is an argument rather than a direct `import.meta.env` read, for two reasons: it keeps
 * this module testable without a Vite pipeline, and it keeps `import.meta.env` confined to the one
 * call site in `app/` that ESLint allows.
 *
 * `parse`, not `safeParse`: a bundle built with a broken configuration cannot render anything
 * useful, and a blank screen with a console error is worse than a loud failure.
 */
export const loadClientEnv = (source: Readonly<Record<string, unknown>>): ClientEnv =>
  clientEnvSchema.parse(source);
