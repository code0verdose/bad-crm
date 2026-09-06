/**
 * What the end-to-end run has to say for itself, turned into the markdown a job summary shows.
 *
 * A run reports «26 passed» and that is not a report: the day the isolation scenarios stop being
 * executed — a rename, a filter, a file left out of the index — the number becomes 24 and reads as
 * a smaller suite rather than as a lost gate. Two things therefore get lines of their own here:
 *
 * - **which scenarios failed, and which were flaky.** A flaky one is a pass in the exit code and a
 *   defect in the product or the suite; if the only place it appears is a green check mark nobody
 *   ever opens it.
 * - **tenant isolation, as a verdict.** It is invariant No. 1 and a release gate in the PRD, so it
 *   is stated separately and its **absence** is a third value, not a silent pass.
 *
 * The shape read here is Playwright's JSON reporter, and only the fields actually used are typed:
 * a full mirror of that schema would be a second contract to maintain against a version bump.
 */

/** A suite node of the JSON report: files and `describe` blocks are the same shape. */
export interface ReportSuite {
  readonly title?: string;
  readonly file?: string;
  readonly suites?: readonly ReportSuite[];
  readonly specs?: readonly {
    readonly title?: string;
    readonly ok?: boolean;
    readonly tests?: readonly { readonly status?: string }[];
  }[];
}

export interface PlaywrightReport {
  readonly stats: {
    readonly expected: number;
    readonly unexpected: number;
    readonly flaky: number;
    readonly skipped: number;
  };
  readonly suites?: readonly ReportSuite[];
}

export interface Outcome {
  /** The spec file, relative to `testDir` — what a reader needs to find the scenario. */
  readonly file: string;
  /** Every enclosing `describe` and the scenario itself, as one line. */
  readonly title: string;
  /** Playwright's own word: `expected`, `unexpected`, `flaky`, `skipped`. */
  readonly status: string;
}

export type IsolationVerdict = 'passed' | 'failed' | 'missing';

/** Where the tenant isolation scenarios live. A rename that moves them out is caught by `missing`. */
const ISOLATION_DIRECTORY = 'tenancy/';

/**
 * Flattens the report into one line per scenario.
 *
 * The file lives on the outermost node and the titles on the way down, so both are carried through
 * the recursion rather than looked up afterwards.
 */
export const collect = (report: PlaywrightReport): Outcome[] => {
  const walk = (suite: ReportSuite, file: string, path: readonly string[]): Outcome[] => {
    const here = suite.file ?? file;
    // The file-level node repeats the file name as its title; a `describe` contributes a real one.
    const titles =
      suite.title === undefined || suite.title === here ? path : [...path, suite.title];

    return [
      ...(suite.specs ?? []).map((spec) => ({
        file: here,
        title: [...titles, spec.title ?? ''].join(' › '),
        status: spec.tests?.[0]?.status ?? (spec.ok === true ? 'expected' : 'unexpected'),
      })),
      ...(suite.suites ?? []).flatMap((child) => walk(child, here, titles)),
    ];
  };

  return (report.suites ?? []).flatMap((suite) => walk(suite, suite.file ?? '', []));
};

/**
 * Did the isolation promise hold in this run — and was it even asked?
 *
 * A flaky isolation scenario counts as failed. «It held on the second attempt» is not a property
 * anybody wants to ship: either the boundary is deterministic or the check is, and both need
 * looking at.
 */
export const isolationVerdict = (outcomes: readonly Outcome[]): IsolationVerdict => {
  const isolation = outcomes.filter((outcome) => outcome.file.includes(ISOLATION_DIRECTORY));

  if (isolation.length === 0) return 'missing';

  return isolation.every((outcome) => outcome.status === 'expected' || outcome.status === 'skipped')
    ? 'passed'
    : 'failed';
};

const listOf = (heading: string, outcomes: readonly Outcome[]): string[] =>
  outcomes.length === 0
    ? []
    : ['', `### ${heading}`, '', ...outcomes.map(({ file, title }) => `- \`${file}\` — ${title}`)];

/** The markdown the job appends to `$GITHUB_STEP_SUMMARY`. */
export const renderSummary = (
  outcomes: readonly Outcome[],
  stats: PlaywrightReport['stats'],
): string => {
  const failed = outcomes.filter((outcome) => outcome.status === 'unexpected');
  const flaky = outcomes.filter((outcome) => outcome.status === 'flaky');

  return [
    '## End-to-end',
    '',
    `**tenant isolation: ${isolationVerdict(outcomes)}**`,
    '',
    `| passed | failed | flaky | skipped |`,
    `| --- | --- | --- | --- |`,
    `| ${String(stats.expected)} | ${String(stats.unexpected)} | ${String(stats.flaky)} | ${String(stats.skipped)} |`,
    ...listOf('Failed scenarios', failed),
    ...listOf('Flaky scenarios', flaky),
    ...(failed.length > 0 || flaky.length > 0
      ? [
          '',
          'Traces, screenshots and videos are in the `e2e-failure-*` artifact of this run; open one',
          'with `pnpm --filter @bad-crm/e2e exec playwright show-trace <file>`',
          '(`docs/runbooks/e2e.md` → «Когда падает»).',
        ]
      : []),
  ].join('\n');
};
