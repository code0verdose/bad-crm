/**
 * The entry point of `pnpm i18n:unused`: the filesystem around the parse.
 *
 * `i18n-unused.test.ts` proves the detector on sources written for the test. This file proves the
 * part that exists only once — that it reads the tree this repository actually ships — and it does
 * the one thing a synthetic fixture cannot: it runs the **positive control on the real inputs**. A
 * fabricated key added to the real catalogue has to come out orphaned, and a real key has to stay
 * used. Without that pair, «0 orphaned» over 613 keys is indistinguishable from a parse that
 * silently stopped reading the tree.
 */
/*
 * The ban on `node:fs` keeps every repository read hashed by `//#test:repo`. Nothing here reads the
 * repository: the temp file stands in for the job summary a workflow provides, and the tree is read
 * by the script under test.
 */
// eslint-disable-next-line no-restricted-imports -- temp files only, never a repository path
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { readInputs, run } from '../../scripts/ci/i18n-unused.js';
import { audit } from '../../scripts/ci/i18n-unused.util.js';

const silently = <T>(body: () => T): T => {
  const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

  try {
    return body();
  } finally {
    write.mockRestore();
  }
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('pnpm i18n:unused', () => {
  it("passes on this repository's own catalogues", () => {
    vi.stubEnv('GITHUB_STEP_SUMMARY', '');

    expect(silently(run)).toBe(0);
  });

  it('CONTROL: reads a non-trivial tree — catalogue, sources, schemas and permissions all found', () => {
    const inputs = readInputs();

    expect(inputs.catalogue.length).toBeGreaterThan(400);
    expect(inputs.namespaces.length).toBeGreaterThan(10);
    expect(inputs.screens.length).toBeGreaterThan(100);
    expect(inputs.schemas.length).toBeGreaterThan(5);
    // The permission catalogue: a wrong path here reads as «nothing describes a permission», and
    // every sentence of the `permission` namespace would be reported as an orphan.
    expect(inputs.catalogs.length).toBeGreaterThan(3);
  });

  /**
   * The control that makes the green above mean something: one key nothing asks for, planted in the
   * real catalogue, and one key the interface really does ask for, asserted to stay out of the
   * report. A parse that had quietly stopped resolving usage would fail the second half; a parse
   * that marked everything used would fail the first.
   */
  it('CONTROL: finds a planted orphan in the real catalogue and leaves a real key alone', () => {
    const inputs = readInputs();
    const planted = 'common.thisKeyIsAskedForByNothing';

    const report = audit({ ...inputs, catalogue: [...inputs.catalogue, planted] });

    expect(report.orphaned).toEqual([planted]);
    expect(inputs.catalogue).toContain('common.retry');
    expect(report.orphaned).not.toContain('common.retry');
  });

  /**
   * The calibration the report prints, asserted rather than trusted: a `t('…')`-only reading of the
   * same tree calls hundreds of live keys orphaned, which is why this scanner reads the other
   * shapes at all.
   */
  it('CONTROL: a `t()`-only reading of the same tree is wrong about hundreds of keys', () => {
    expect(audit(readInputs()).naiveOrphaned.length).toBeGreaterThan(200);
  });

  it('prints the table', () => {
    vi.stubEnv('GITHUB_STEP_SUMMARY', '');
    let printed = '';
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      printed += String(chunk);
      return true;
    });

    try {
      run();
    } finally {
      write.mockRestore();
    }

    expect(printed).toContain('## Unused translations');
    expect(printed).toContain('| Orphaned | 0 |');
  });

  it('appends the table to the job summary when the workflow provides one', () => {
    const summaryPath = join(mkdtempSync(join(tmpdir(), 'i18n-unused-')), 'summary.md');
    writeFileSync(summaryPath, '# existing\n', 'utf8');
    vi.stubEnv('GITHUB_STEP_SUMMARY', summaryPath);

    silently(run);

    const written = readFileSync(summaryPath, 'utf8');
    expect(written).toContain('# existing');
    expect(written).toContain('## Unused translations');
  });

  it('writes nothing anywhere when it is run outside a workflow', () => {
    vi.stubEnv('GITHUB_STEP_SUMMARY', '');

    expect(() => silently(run)).not.toThrow();
  });
});
