/**
 * Identity of the running process: the name and role every log line is stamped with, and the
 * version `/health` reports so an operator can tell which build is deployed.
 *
 * `version` is a literal rather than a read of `package.json`: the built artefact is
 * `dist/main.js`, and reaching for a manifest relative to it is the kind of path that works in
 * development and breaks in the image. `test/unit/app-info.test.ts` holds the two in sync, so the
 * duplication cannot drift silently.
 */
export const APP_INFO = {
  name: '@bad-crm/server',
  role: 'api',
  version: '0.0.0',
} as const;
