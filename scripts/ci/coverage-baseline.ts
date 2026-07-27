/**
 * `pnpm coverage:baseline` — did this change make coverage worse?
 *
 * Reads the `json-summary` report each project's vitest run leaves in `coverage/`, compares it
 * against the committed `coverage-baseline.json`, prints a markdown table (the workflow appends it
 * to the job summary) and exits non-zero on a regression. `--update` rewrites the baseline with
 * the numbers of the current run — a deliberate act, reviewable as a line in the diff.
 *
 * The comparison logic lives in `coverage-baseline.util.ts`; this file is the filesystem around it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  baselineOf,
  compareToBaseline,
  metricsOfSummary,
  renderReport,
  summaryPathOf,
  verdictOf,
  type CoverageBaseline,
  type MeasuredCoverage,
} from './coverage-baseline.util.js';
import { isEntryPoint, repoRoot } from '../lib/repo-paths.util.js';

const BASELINE_PATH = 'coverage-baseline.json';

const readJsonFile = (relativePath: string): unknown =>
  JSON.parse(readFileSync(join(repoRoot, relativePath), 'utf8')) as unknown;

/** A project with no report is left undefined; the comparison reports it as a missing report. */
const measure = (projects: readonly string[]): MeasuredCoverage =>
  Object.fromEntries(
    projects.map((project) => {
      try {
        return [project, metricsOfSummary(readJsonFile(summaryPathOf(project)))];
      } catch {
        return [project, undefined];
      }
    }),
  );

if (isEntryPoint(import.meta.url)) {
  const baseline = readJsonFile(BASELINE_PATH) as CoverageBaseline;
  const measured = measure(Object.keys(baseline.projects));

  if (process.argv.includes('--update')) {
    const updated = baselineOf(baseline, measured);

    writeFileSync(join(repoRoot, BASELINE_PATH), `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
    process.stdout.write(`${BASELINE_PATH} updated from the current run\n`);
  } else {
    const rows = compareToBaseline(baseline, measured);

    process.stdout.write(`${renderReport(rows, baseline.tolerance)}\n`);
    process.exitCode = verdictOf(rows);
  }
}
