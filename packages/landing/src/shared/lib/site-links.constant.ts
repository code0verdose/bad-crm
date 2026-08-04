/**
 * The anchors the header navigates to, in one place.
 *
 * A section and the link that points at it are written in two different files, so the id is the one
 * string that can drift silently — a typo produces a link that does nothing and no error anywhere.
 */
export const SECTION_IDS = {
  main: 'main',
  workspace: 'workspace',
  domains: 'domains',
  security: 'security',
  selfHost: 'self-host',
} as const;

export const GITHUB_URL = 'https://github.com/code0verdose/bad-crm';
export const LICENCE_URL = 'https://www.gnu.org/licenses/agpl-3.0.html';
