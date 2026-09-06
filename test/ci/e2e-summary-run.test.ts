/**
 * The entry point of the job-summary step: the filesystem around the arithmetic.
 *
 * `e2e-summary.test.ts` proves the counting on reports written for the test. This file proves the
 * parts that exist only once — that the markdown lands where the workflow looks for it, that a run
 * without an isolation scenario fails loudly rather than printing a comforting total, and that a
 * missing report does not turn this step into a second, misleading failure.
 */
/*
 * The ban on `node:fs` exists so every **repository** file a test reads goes through `readRepoFile`
 * and stays hashed by `//#test:repo`. Nothing here touches the repository: these calls create files
 * in the system temp directory, standing in for a run's report and for a job summary.
 */
// eslint-disable-next-line no-restricted-imports -- temp files only, never a repository path
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { run } from '../../scripts/ci/e2e-summary.js';

const silently = <T>(body: () => T): T => {
  const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

  try {
    return body();
  } finally {
    write.mockRestore();
  }
};

const workspace = (): string => mkdtempSync(join(tmpdir(), 'e2e-summary-'));

const reportWith = (
  specs: { file: string; title: string; status: string }[],
  stats: Record<string, number>,
): string => {
  const path = join(workspace(), 'report.json');

  writeFileSync(
    path,
    JSON.stringify({
      stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 0, ...stats },
      suites: specs.map(({ file, title, status }) => ({
        title: file,
        file,
        specs: [{ title, ok: status === 'expected', tests: [{ status }] }],
      })),
    }),
  );

  return path;
};

const ISOLATION = {
  file: 'tenancy/cross-tenant-api.spec.ts',
  title: 'refuses a foreign session',
  status: 'expected',
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the end-to-end job summary', () => {
  it('writes the markdown where the workflow renders it', () => {
    const summary = join(workspace(), 'summary.md');
    writeFileSync(summary, '');
    vi.stubEnv('GITHUB_STEP_SUMMARY', summary);

    const code = silently(() => run(reportWith([ISOLATION], { expected: 1 })));

    expect(code).toBe(0);
    expect(readFileSync(summary, 'utf8')).toContain('tenant isolation: passed');
  });

  it('names the failed scenario there rather than only a count', () => {
    const summary = join(workspace(), 'summary.md');
    writeFileSync(summary, '');
    vi.stubEnv('GITHUB_STEP_SUMMARY', summary);

    silently(() =>
      run(
        reportWith(
          [
            ISOLATION,
            { file: 'auth/enable-2fa.spec.ts', title: 'enables TOTP', status: 'unexpected' },
          ],
          { expected: 1, unexpected: 1 },
        ),
      ),
    );

    expect(readFileSync(summary, 'utf8')).toContain('auth/enable-2fa.spec.ts');
  });

  /**
   * The gate this script owns. A failed scenario is already red; a suite that stopped running the
   * isolation scenarios is green everywhere else, and only this refuses it.
   */
  it('fails when the run carried no isolation scenario at all', () => {
    vi.stubEnv('GITHUB_STEP_SUMMARY', '');

    const code = silently(() =>
      run(
        reportWith([{ file: 'smoke/sign-in.spec.ts', title: 'signs in', status: 'expected' }], {
          expected: 1,
        }),
      ),
    );

    expect(code).toBe(1);
  });

  it('CONTROL: the same run with the isolation scenario present passes', () => {
    vi.stubEnv('GITHUB_STEP_SUMMARY', '');

    const code = silently(() =>
      run(
        reportWith(
          [ISOLATION, { file: 'smoke/sign-in.spec.ts', title: 'signs in', status: 'expected' }],
          {
            expected: 2,
          },
        ),
      ),
    );

    expect(code).toBe(0);
  });

  /**
   * A run that died before writing a report has already turned the job red at the step that ran it.
   * Failing here as well would put a second, louder failure on the step that only reports.
   */
  it('says so and stays quiet when there is no report', () => {
    vi.stubEnv('GITHUB_STEP_SUMMARY', '');

    const code = silently(() => run(join(workspace(), 'absent.json')));

    expect(code).toBe(0);
  });

  it('does not fall over when the job provides no summary file', () => {
    vi.stubEnv('GITHUB_STEP_SUMMARY', undefined);

    expect(() => silently(() => run(reportWith([ISOLATION], { expected: 1 })))).not.toThrow();
  });
});
