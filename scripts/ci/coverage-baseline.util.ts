/**
 * The regression half of STORY-002-02.
 *
 * `coverage.thresholds` in each `vitest.config.ts` is the floor of `rules/testing.mdc` §7: it
 * answers "is this package above 85 %". It cannot answer "did this pull request make coverage
 * worse", because a package sitting at 97 % can shed twelve points and still be over its floor.
 * This file is that second question: the numbers a green run produced are committed to
 * `coverage-baseline.json`, and a later run that falls more than the tolerance below them fails.
 *
 * Two alternatives were rejected. Vitest's `thresholds.autoUpdate` rewrites the thresholds in the
 * config after a passing run — it only ever ratchets up, it makes CI edit a tracked file, and
 * `test/repo/coverage-contract.test.ts` asserts the thresholds equal the table in
 * `rules/testing.mdc` §7, which an autoupdated number would not. A bot comment on the pull request
 * needs `pull-requests: write`, and the token of a `pull_request` event from a fork is read-only —
 * the check would go quiet exactly on contributions from outside. A file in the repository works
 * for forks, needs no token and no service, and makes lowering the bar a reviewable line in the
 * diff instead of a silent event in a bot's history.
 */

/** Percentages of the `total` block of a v8 `coverage-summary.json`. */
export interface CoverageMetrics {
  readonly lines: number;
  readonly branches: number;
}

/** The committed expectation: one entry per project that reports coverage. */
export interface CoverageBaseline {
  readonly tolerance: number;
  readonly projects: Readonly<Record<string, CoverageMetrics>>;
}

/** What a run measured, keyed the same way as the baseline. */
export type MeasuredCoverage = Readonly<Record<string, CoverageMetrics | undefined>>;

export type ComparisonStatus = 'ok' | 'improved' | 'regressed' | 'missing';

export interface Comparison {
  readonly project: string;
  readonly metric: 'lines' | 'branches';
  readonly baseline: number;
  readonly measured: number | undefined;
  readonly delta: number | undefined;
  readonly status: ComparisonStatus;
}

/** STORY-002-02: half a percentage point of noise is tolerated, more is a regression. */
export const DEFAULT_TOLERANCE = 0.5;

const METRICS = ['lines', 'branches'] as const;

interface SummaryTotals {
  total?: Record<string, { pct?: number } | undefined>;
}

/**
 * Reads the `total` block of a v8 coverage summary.
 *
 * Throws rather than defaulting: a report without totals is not a report with zero coverage, and
 * reading it as zero would fail the run with a reason that sends the reader to the wrong file.
 */
export const metricsOfSummary = (summary: unknown): CoverageMetrics => {
  const total = (summary as SummaryTotals | null)?.total;

  if (total === undefined) {
    throw new Error('coverage summary has no `total` block — is this a v8 json-summary report?');
  }

  const read = (metric: (typeof METRICS)[number]): number => {
    const pct = total[metric]?.pct;

    if (typeof pct !== 'number') {
      throw new Error(`coverage summary has no total.${metric}.pct`);
    }

    return pct;
  };

  return { lines: read('lines'), branches: read('branches') };
};

/** Where a project's `json-summary` reporter writes, relative to the repository root. */
export const summaryPathOf = (project: string): string =>
  project === '.' ? 'coverage/coverage-summary.json' : `${project}/coverage/coverage-summary.json`;

const round = (value: number): number => Math.round(value * 100) / 100;

/**
 * One row per baselined project and metric.
 *
 * Projects that were measured but are not in the baseline are skipped on purpose: a package that
 * starts reporting coverage should be added to the file deliberately (`--update`), not enrolled
 * into a gate by the accident of having produced a report.
 */
export const compareToBaseline = (
  baseline: CoverageBaseline,
  measured: MeasuredCoverage,
): Comparison[] =>
  Object.entries(baseline.projects).flatMap(([project, expected]) =>
    METRICS.map((metric): Comparison => {
      const actual = measured[project]?.[metric];

      if (actual === undefined) {
        return {
          project,
          metric,
          baseline: expected[metric],
          measured: undefined,
          delta: undefined,
          status: 'missing',
        };
      }

      const delta = round(actual - expected[metric]);
      const status: ComparisonStatus =
        delta < -baseline.tolerance ? 'regressed' : delta > 0 ? 'improved' : 'ok';

      return { project, metric, baseline: expected[metric], measured: actual, delta, status };
    }),
  );

/** Exit code of a comparison: anything missing or regressed fails the run. */
export const verdictOf = (rows: readonly Comparison[]): 0 | 1 =>
  rows.some((row) => row.status === 'regressed' || row.status === 'missing') ? 1 : 0;

const SYMBOL: Record<ComparisonStatus, string> = {
  ok: '=',
  improved: '↑',
  regressed: '↓ regressed',
  missing: '✗ no report',
};

const cell = (value: number | undefined): string => (value === undefined ? '—' : value.toFixed(2));

const signed = (delta: number | undefined): string =>
  delta === undefined ? '—' : `${delta > 0 ? '+' : ''}${delta.toFixed(2)}`;

/** The job summary: the whole table, not only the failures — a run is also evidence of progress. */
export const renderReport = (rows: readonly Comparison[], tolerance: number): string => {
  const lines = [
    '### Coverage against the baseline',
    '',
    `Tolerance: ${tolerance} percentage points below \`coverage-baseline.json\`.`,
    '',
    '| Project | Metric | Baseline | Measured | Delta |',
    '| --- | --- | ---: | ---: | --- |',
    ...rows.map(
      (row) =>
        `| \`${row.project}\` | ${row.metric} | ${cell(row.baseline)} | ${cell(row.measured)} | ` +
        `${signed(row.delta)} ${SYMBOL[row.status]} |`,
    ),
  ];

  if (verdictOf(rows) === 1) {
    lines.push(
      '',
      'Coverage fell below the committed baseline. Add the missing tests, or — if the drop is',
      'intended and explained in the pull request — move the baseline on purpose with',
      '`pnpm coverage:baseline --update`.',
    );
  }

  return lines.join('\n');
};

/**
 * The baseline `--update` writes: measured numbers for the baselined projects, and the previous
 * number for a project whose report is missing, so that a partial run cannot quietly lower the bar.
 */
export const baselineOf = (
  previous: CoverageBaseline,
  measured: MeasuredCoverage,
): CoverageBaseline => ({
  tolerance: previous.tolerance,
  projects: Object.fromEntries(
    Object.entries(previous.projects).map(([project, expected]) => [
      project,
      measured[project] ?? expected,
    ]),
  ),
});
