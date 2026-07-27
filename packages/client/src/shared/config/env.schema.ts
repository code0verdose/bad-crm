import { z } from 'zod';

/**
 * Environment of the browser bundle.
 *
 * This is a **separate, much smaller** schema than the server's on purpose. Vite inlines matching
 * variables into the JavaScript it ships, so anything named here is readable by anyone who opens
 * devtools. Server secrets — `JWT_SECRET`, `APP_ENCRYPTION_KEY`, `MEILI_MASTER_KEY`, S3 and
 * database credentials — therefore have no representation here at all, and the client never talks
 * to Meilisearch, S3 or an AI provider directly (rules/security.mdc, rule 3).
 *
 * The `VITE_` prefix is not decoration: it is the mechanism. Vite refuses to expose any other
 * variable, so a secret can only leak by being deliberately renamed — which
 * `test/env/env-example-sync.test.ts` rejects.
 */
export const CLIENT_ENV_PREFIX = 'VITE_';

/** Schemes a browser will fetch JSON over. Everything else is either inert or an injection. */
const FETCHABLE_SCHEMES = ['http:', 'https:'] as const;

/**
 * Accepts a same-origin absolute path (`/api/v1`) or an absolute `http(s)` URL, and nothing else.
 *
 * The value decides where every API call — and every credential attached to it — is sent, so
 * "non-empty string" is not a validation. Two shapes matter in particular:
 *
 * - `//evil.example.com/api` is protocol-relative. It starts with a slash, so a path check waves
 *   it through, but a browser reads it as a different origin on the current scheme.
 * - `/\evil.example.com/api` is the same attack spelled with a backslash. The WHATWG URL parser
 *   treats `\` as `/` for special schemes, so this is protocol-relative too — a check that only
 *   looks for `//` waves it through and every request leaves for another origin.
 * - `javascript:` and `data:` are not transports; they are the payload of an XSS if the value ever
 *   reaches an attribute.
 */
const isSameOriginPathOrHttpUrl = (value: string): boolean => {
  // Normalise before deciding: for special schemes a browser reads `\` exactly as `/`, and the
  // WHATWG URL parser strips ASCII tab, CR and LF outright — so `/<TAB>/evil.example.com` is
  // protocol-relative too. The comparison has to happen on the shape the browser sees, not the
  // one the operator typed.
  const asBrowserReadsIt = value.replaceAll('\\', '/').replace(/[\t\n\r]/g, '');

  if (asBrowserReadsIt.startsWith('/')) return !asBrowserReadsIt.startsWith('//');

  try {
    return (FETCHABLE_SCHEMES as readonly string[]).includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

export const clientEnvSchema = z.object({
  /**
   * Where the API lives. A relative path by default: the SPA is served from the same origin as the
   * API in every profile, so an absolute URL is only needed when the two are split.
   */
  VITE_API_BASE_URL: z
    .string()
    .refine(isSameOriginPathOrHttpUrl, {
      error:
        'VITE_API_BASE_URL must be a same-origin path starting with a single "/" (for example /api/v1) or an absolute http(s) URL',
    })
    .default('/api/v1'),
});

export type ClientEnv = z.infer<typeof clientEnvSchema>;
