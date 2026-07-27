import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TOLERANCE,
  baselineOf,
  compareToBaseline,
  metricsOfSummary,
  renderReport,
  summaryPathOf,
  verdictOf,
  type CoverageBaseline,
  type MeasuredCoverage,
} from '../../scripts/ci/coverage-baseline.util.js';

const baseline: CoverageBaseline = {
  tolerance: 0.5,
  projects: {
    '.': { lines: 80, branches: 70 },
    'packages/server': { lines: 90, branches: 85 },
  },
};

const measured = (overrides: MeasuredCoverage = {}): MeasuredCoverage => ({
  '.': { lines: 80, branches: 70 },
  'packages/server': { lines: 90, branches: 85 },
  ...overrides,
});

describe('reading a v8 coverage summary', () => {
  it('takes the totals of the report', () => {
    const summary = {
      total: {
        lines: { total: 10, covered: 8, skipped: 0, pct: 81.75 },
        branches: { total: 4, covered: 3, skipped: 0, pct: 73.97 },
      },
    };

    expect(metricsOfSummary(summary)).toEqual({ lines: 81.75, branches: 73.97 });
  });

  it('rejects a report without totals instead of reading it as zero coverage', () => {
    // A zero would be indistinguishable from "every threshold collapsed", and the run would fail
    // with the wrong reason — the honest answer is that the report is not a coverage report.
    expect(() => metricsOfSummary({ files: {} })).toThrow(/total/i);
  });

  it('derives the report path of the root project and of a package', () => {
    expect(summaryPathOf('.')).toBe('coverage/coverage-summary.json');
    expect(summaryPathOf('packages/server')).toBe('packages/server/coverage/coverage-summary.json');
  });
});

describe('comparing a run against the baseline', () => {
  it('accepts a run that matches the baseline exactly', () => {
    const rows = compareToBaseline(baseline, measured());

    expect(rows.every((row) => row.status === 'ok')).toBe(true);
    expect(verdictOf(rows)).toBe(0);
  });

  it('accepts a drop inside the tolerance', () => {
    const rows = compareToBaseline(baseline, measured({ '.': { lines: 79.6, branches: 70 } }));

    expect(verdictOf(rows)).toBe(0);
  });

  it('fails a drop past the tolerance, naming project, metric and both numbers', () => {
    const rows = compareToBaseline(baseline, measured({ '.': { lines: 79.4, branches: 70 } }));
    const regression = rows.find((row) => row.status === 'regressed');

    expect(verdictOf(rows)).toBe(1);
    expect(regression).toMatchObject({
      project: '.',
      metric: 'lines',
      baseline: 80,
      measured: 79.4,
    });
    expect(renderReport(rows, baseline.tolerance)).toContain('79.4');
  });

  it('fails a branch regression even when lines are untouched', () => {
    const rows = compareToBaseline(
      baseline,
      measured({ 'packages/server': { lines: 90, branches: 80 } }),
    );

    expect(verdictOf(rows)).toBe(1);
    expect(rows.filter((row) => row.status === 'regressed').map((row) => row.metric)).toEqual([
      'branches',
    ]);
  });

  /**
   * A missing report is the failure mode that matters most: it is what a run produces when the
   * test task was skipped, filtered or served from a cache written before coverage existed. Read
   * as "nothing to compare", it would turn the gate off exactly when it stopped working.
   */
  it('fails when a baselined project produced no report at all', () => {
    const rows = compareToBaseline(baseline, { '.': { lines: 80, branches: 70 } });

    expect(verdictOf(rows)).toBe(1);
    expect(rows.find((row) => row.status === 'missing')?.project).toBe('packages/server');
  });

  it('reports an improvement without failing the run', () => {
    const rows = compareToBaseline(baseline, measured({ '.': { lines: 92, branches: 88 } }));

    expect(verdictOf(rows)).toBe(0);
    expect(rows.some((row) => row.status === 'improved')).toBe(true);
  });

  it('ignores a project that is measured but not baselined, so a new package cannot fail a run', () => {
    const rows = compareToBaseline(
      baseline,
      measured({ 'packages/client': { lines: 1, branches: 1 } }),
    );

    expect(rows.some((row) => row.project === 'packages/client')).toBe(false);
    expect(verdictOf(rows)).toBe(0);
  });
});

describe('the report', () => {
  it('is a markdown table naming every baselined project', () => {
    const report = renderReport(compareToBaseline(baseline, measured()), baseline.tolerance);

    expect(report).toContain('| Project | Metric | Baseline | Measured | Delta |');
    expect(report).toContain('packages/server');
  });

  it('states the tolerance, so the number is not folklore', () => {
    expect(renderReport(compareToBaseline(baseline, measured()), 0.5)).toContain('0.5');
  });

  it('names the command that moves the baseline on purpose', () => {
    const rows = compareToBaseline(baseline, measured({ '.': { lines: 10, branches: 10 } }));

    expect(renderReport(rows, baseline.tolerance)).toContain('--update');
  });
});

describe('updating the baseline', () => {
  it('writes the measured numbers of the baselined projects only', () => {
    const updated = baselineOf(
      baseline,
      measured({ 'packages/client': { lines: 5, branches: 5 } }),
    );

    expect(updated.projects).toEqual({
      '.': { lines: 80, branches: 70 },
      'packages/server': { lines: 90, branches: 85 },
    });
  });

  it('keeps the tolerance of the file it replaces', () => {
    expect(baselineOf({ ...baseline, tolerance: 0.25 }, measured()).tolerance).toBe(0.25);
  });

  it('leaves a baselined project untouched when its report is missing', () => {
    const updated = baselineOf(baseline, { '.': { lines: 99, branches: 99 } });

    expect(updated.projects['packages/server']).toEqual({ lines: 90, branches: 85 });
  });
});

describe('the tolerance of record', () => {
  it('is the half a percentage point STORY-002-02 asks for', () => {
    expect(DEFAULT_TOLERANCE).toBe(0.5);
  });
});
