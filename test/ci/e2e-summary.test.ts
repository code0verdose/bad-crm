/**
 * The end-to-end run has to say what happened, in the place a reviewer already looks.
 *
 * «26 passed» is not a report: when a scenario disappears from the suite the number simply becomes
 * 24, and nothing about that reads as a loss. Two things therefore get their own lines in the job
 * summary — which scenarios failed or were flaky, and whether tenant isolation held. The second is
 * invariant No. 1 of the product and a release gate in the PRD, so it may not dissolve into a total.
 *
 * The arithmetic is here; the filesystem around it is in `e2e-summary-run.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import {
  collect,
  isolationVerdict,
  renderSummary,
  type PlaywrightReport,
} from '../../scripts/ci/e2e-summary.util.js';

/** A report shaped the way Playwright's JSON reporter writes one, with only the fields read. */
const reportOf = (
  specs: { file: string; title: string; status: string }[],
  stats: Partial<PlaywrightReport['stats']> = {},
): PlaywrightReport => ({
  stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 0, ...stats },
  suites: specs.map(({ file, title, status }) => ({
    title: file,
    file,
    specs: [{ title, ok: status === 'expected', tests: [{ status }] }],
  })),
});

const PASSING_ISOLATION = {
  file: 'tenancy/cross-tenant-api.spec.ts',
  title: 'refuses a session of another organization',
  status: 'expected',
};

describe('reading the run out of the report', () => {
  it('finds a scenario in a nested suite, which is where a describe puts it', () => {
    const report: PlaywrightReport = {
      stats: { expected: 1, unexpected: 0, flaky: 0, skipped: 0 },
      suites: [
        {
          title: 'smoke/sign-in.spec.ts',
          file: 'smoke/sign-in.spec.ts',
          suites: [
            {
              title: 'signing in',
              specs: [{ title: 'reaches the shell', ok: true, tests: [{ status: 'expected' }] }],
            },
          ],
        },
      ],
    };

    expect(collect(report)).toEqual([
      {
        file: 'smoke/sign-in.spec.ts',
        title: 'signing in › reaches the shell',
        status: 'expected',
      },
    ]);
  });

  it('keeps the file a scenario came from, so a name can be traced to a spec', () => {
    expect(collect(reportOf([PASSING_ISOLATION]))[0]?.file).toBe(
      'tenancy/cross-tenant-api.spec.ts',
    );
  });
});

describe('the tenant isolation verdict', () => {
  it('is passed when every isolation scenario passed', () => {
    expect(isolationVerdict(collect(reportOf([PASSING_ISOLATION])))).toBe('passed');
  });

  it('is failed when one of them did not', () => {
    const outcomes = collect(
      reportOf([
        PASSING_ISOLATION,
        {
          file: 'tenancy/cross-tenant-ui.spec.ts',
          title: 'hides a stranger',
          status: 'unexpected',
        },
      ]),
    );

    expect(isolationVerdict(outcomes)).toBe('failed');
  });

  /**
   * The case the whole line exists for. A suite that stopped running its isolation scenarios is
   * green, shorter by two, and indistinguishable from a suite that ran them — unless the absence
   * itself is a verdict. It is not «passed», and it may not be silent.
   */
  it('is missing when the run contained no isolation scenario at all', () => {
    const outcomes = collect(
      reportOf([{ file: 'smoke/sign-in.spec.ts', title: 'reaches the shell', status: 'expected' }]),
    );

    expect(isolationVerdict(outcomes)).toBe('missing');
  });

  it('counts a flaky isolation scenario as failed: it did not hold on the first attempt', () => {
    const outcomes = collect(reportOf([{ ...PASSING_ISOLATION, status: 'flaky' }]));

    expect(isolationVerdict(outcomes)).toBe('failed');
  });
});

describe('the summary a reviewer reads', () => {
  const summaryOf = (report: PlaywrightReport): string =>
    renderSummary(collect(report), report.stats);

  it('names every failed scenario with its file', () => {
    const markdown = summaryOf(
      reportOf(
        [
          PASSING_ISOLATION,
          { file: 'auth/enable-2fa.spec.ts', title: 'enables TOTP', status: 'unexpected' },
        ],
        { expected: 1, unexpected: 1 },
      ),
    );

    expect(markdown).toContain('auth/enable-2fa.spec.ts');
    expect(markdown).toContain('enables TOTP');
  });

  it('lists a flaky scenario separately from a failed one', () => {
    const markdown = summaryOf(
      reportOf(
        [
          PASSING_ISOLATION,
          { file: 'auth/login-with-2fa.spec.ts', title: 'signs in', status: 'flaky' },
        ],
        { expected: 1, flaky: 1 },
      ),
    );

    expect(markdown).toMatch(/[Ff]laky/);
    expect(markdown).toContain('auth/login-with-2fa.spec.ts');
  });

  it('states the isolation verdict on a line of its own', () => {
    expect(summaryOf(reportOf([PASSING_ISOLATION], { expected: 1 }))).toContain(
      'tenant isolation: passed',
    );
  });

  it('says failed there when an isolation scenario failed', () => {
    const markdown = summaryOf(
      reportOf([{ ...PASSING_ISOLATION, status: 'unexpected' }], { unexpected: 1 }),
    );

    expect(markdown).toContain('tenant isolation: failed');
  });

  it('says missing there when the run carried none, rather than nothing at all', () => {
    const markdown = summaryOf(
      reportOf([{ file: 'smoke/sign-in.spec.ts', title: 'reaches', status: 'expected' }], {
        expected: 1,
      }),
    );

    expect(markdown).toContain('tenant isolation: missing');
  });

  it('carries the totals, so the summary stands on its own', () => {
    const markdown = summaryOf(
      reportOf([PASSING_ISOLATION], { expected: 12, unexpected: 1, flaky: 2, skipped: 3 }),
    );

    for (const number of ['12', '1', '2', '3']) expect(markdown).toContain(number);
  });

  /**
   * A green run is the common case and it gets one short block: nobody needs a table of twenty-six
   * names that all say «passed».
   */
  it('does not print a failure section when there were none', () => {
    const markdown = summaryOf(reportOf([PASSING_ISOLATION], { expected: 1 }));

    expect(markdown).not.toMatch(/[Ff]ailed scenarios/);
  });
});
