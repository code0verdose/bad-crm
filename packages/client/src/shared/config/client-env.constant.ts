import { loadClientEnv } from './load-client-env.util.js';

/**
 * The browser configuration of this installation, parsed once.
 *
 * `import.meta.env` is read here and nowhere else — ESLint confines it to `shared/config`, so every
 * other layer imports a validated object instead of a bag of strings, and what the bundle exposes is
 * visible in one schema (`rules/security.mdc` rule 3, `rules/zod-validation.mdc` rule 14).
 *
 * Evaluated at module init rather than behind a function: a bundle built with a broken base URL
 * cannot render anything useful, and failing at the first import is louder than failing on the first
 * request.
 */
export const clientEnv = loadClientEnv(import.meta.env);
