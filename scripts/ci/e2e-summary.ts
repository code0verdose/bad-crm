/**
 * Turns the JSON report of an end-to-end run into the job summary a reviewer reads.
 *
 * The arithmetic is in `e2e-summary.util.ts`; this file is the filesystem around it — where the
 * report is, where the summary goes, and what an absent report means.
 *
 * Usage: `tsx scripts/ci/e2e-summary.ts [path/to/report.json]`.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  collect,
  isolationVerdict,
  renderSummary,
  type PlaywrightReport,
} from './e2e-summary.util.js';
import { isEntryPoint, repoRoot } from '../lib/repo-paths.util.js';

const DEFAULT_REPORT = join(repoRoot, 'packages/e2e/test-results/report.json');

const write = (markdown: string): void => {
  process.stdout.write(`${markdown}\n`);

  const stepSummary = process.env['GITHUB_STEP_SUMMARY'];
  if (stepSummary !== undefined && stepSummary !== '') appendFileSync(stepSummary, `${markdown}\n`);
};

export const run = (reportPath: string = DEFAULT_REPORT): number => {
  let raw: string;

  try {
    raw = readFileSync(reportPath, 'utf8');
  } catch {
    /*
     * No report is not this script's failure to report. It means the run never got far enough to
     * write one — the stack refused to start, the browser was missing — and the step that ran the
     * scenarios has already turned the job red. Saying so and exiting zero keeps the one signal
     * pointing at the cause instead of adding a second, louder one that names the wrong step.
     */
    write(
      [
        '## End-to-end',
        '',
        `No JSON report at \`${reportPath}\` — the run did not get as far as writing one.`,
        'The step that executed the scenarios carries the reason.',
      ].join('\n'),
    );

    return 0;
  }

  const report = JSON.parse(raw) as PlaywrightReport;
  const outcomes = collect(report);

  write(renderSummary(outcomes, report.stats));

  /*
   * The one thing this script fails on by itself: a run that carried no isolation scenario at all.
   * Everything else it reports has already been judged by the run — a failure is red, a flake is
   * named. A suite that quietly stopped exercising invariant No. 1 is green in every other signal
   * there is, and that is exactly the state this line was added to make impossible.
   */
  return isolationVerdict(outcomes) === 'missing' ? 1 : 0;
};

if (isEntryPoint(import.meta.url)) process.exit(run(process.argv[2]));
