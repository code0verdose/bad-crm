import { describe, expect, it } from 'vitest';

import {
  classifyArtifacts,
  exitCodeOf,
  renderScrubReport,
} from '../../scripts/ci/scrub-artifacts.util.js';

/**
 * What may leave the build.
 *
 * The bundle uploaded from an end-to-end run is readable by anybody who can read the build. A saved
 * session file is a live refresh cookie for an account that administers an organization, and an
 * environment file is everything else — both are deleted. A *trace* that contains a cookie is a
 * different case: it is the evidence, so it is named and left alone, and whether naming it is enough
 * is the caller's assertion about where the installation lived.
 */

const file = (path: string, contents?: string) => ({ path, ...(contents === undefined ? {} : { contents }) });

const COOKIE = '{"headers":{"set-cookie":"bad_crm_refresh=abc; Path=/api/v1/auth"}}';

describe('classifying an artifact bundle', () => {
  it.each([
    ['a saved session at the top', 'storage-state-org-a.json'],
    ['a saved session in a subdirectory', 'nested/seed-org-b.session.json'],
    ['an environment file', '.env'],
    ['an environment file with a suffix', '.env.local'],
  ])('removes %s', (_case, path) => {
    expect(classifyArtifacts([file(path, '{}')]).remove).toEqual([path]);
  });

  it('names a trace that carries a session cookie instead of removing it', () => {
    const verdict = classifyArtifacts([file('trace/network.json', COOKIE)]);

    expect(verdict.remove).toEqual([]);
    expect(verdict.carriesCookie).toEqual(['trace/network.json']);
  });

  /**
   * CONTROL: an ordinary bundle is untouched. Without it, a classifier that condemned everything —
   * or one whose patterns matched nothing — would look identical to a working one.
   */
  it('CONTROL: leaves a clean bundle alone', () => {
    const verdict = classifyArtifacts([
      file('report/index.html', '<h1>fine</h1>'),
      file('videos/run.webm'),
      file('screenshots/failed.png'),
    ]);

    expect(verdict).toEqual({ remove: [], carriesCookie: [] });
  });
});

describe('whether the bundle may be published', () => {
  const withCookie = classifyArtifacts([file('trace/network.json', COOKIE)]);
  const clean = classifyArtifacts([file('report/index.html', '<h1>fine</h1>')]);

  it('refuses a cookie-carrying bundle by default', () => {
    expect(exitCodeOf(withCookie, false)).toBe(1);
    expect(renderScrubReport(withCookie, false).err).toContain('Refusing to publish');
  });

  it('allows it when the installation is declared ephemeral, and says so', () => {
    expect(exitCodeOf(withCookie, true)).toBe(0);
    expect(renderScrubReport(withCookie, true).out).toContain('--ephemeral');
    expect(renderScrubReport(withCookie, true).err).toBe('');
  });

  it('publishes a clean bundle either way', () => {
    expect(exitCodeOf(clean, false)).toBe(0);
    expect(exitCodeOf(clean, true)).toBe(0);
  });
});
