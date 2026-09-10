import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  renderRetentionReport,
  type RetentionReport,
} from '../../../scripts/audit-retention.commands.js';
import {
  parseRetentionArguments,
  partitionMonth,
  planRetention,
  retentionCutoff,
} from '../../../scripts/audit-retention.util.js';

/**
 * What `pnpm db:audit-retention` decides — the arithmetic and the argument grammar, without a
 * database. The half that touches PostgreSQL is proved on a container in
 * `test/integration/db/audit-retention.test.ts`.
 *
 * The cases here are the ones that are wrong when written inline: the boundary month (is a
 * partition that is *exactly* N months old detached or kept?), the year boundary, and the DEFAULT
 * partition, which has no month and must never be a candidate.
 */

describe('the month a partition name carries', () => {
  it('reads audit_logs_YYYY_MM as the first day of that month, UTC', () => {
    expect(partitionMonth('audit_logs_2026_08')?.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it.each([
    'audit_logs_default',
    'audit_logs',
    'audit_logs_2026_13',
    'tasks_2026_08',
    'audit_logs_2026_8',
  ])('has no month for %s', (name) => {
    expect(partitionMonth(name)).toBeUndefined();
  });
});

describe('the cutoff', () => {
  it('is the first day of the month N months before now', () => {
    expect(retentionCutoff(new Date('2026-09-06T10:00:00Z'), 12).toISOString()).toBe(
      '2025-09-01T00:00:00.000Z',
    );
  });

  it('crosses the year boundary', () => {
    expect(retentionCutoff(new Date('2026-03-15T00:00:00Z'), 24).toISOString()).toBe(
      '2024-03-01T00:00:00.000Z',
    );
  });

  it('is anchored to UTC, like the partition boundaries themselves', () => {
    // 1 September 00:30 UTC is still August in half the world; `occurred_at` is `timestamptz` and
    // the partition ranges are UTC dates, so the cutoff must be too — or a run in the wrong
    // timezone would detach a month one day early.
    expect(retentionCutoff(new Date('2026-09-01T00:30:00Z'), 12).toISOString()).toBe(
      '2025-09-01T00:00:00.000Z',
    );
  });
});

describe('which partitions retention detaches', () => {
  const NOW = new Date('2026-09-06T10:00:00Z');
  const partitions = [
    'audit_logs_2025_07',
    'audit_logs_2025_08',
    'audit_logs_2025_09',
    'audit_logs_2026_09',
    'audit_logs_2026_11',
    'audit_logs_default',
  ];

  it('detaches every month that ended on or before the cutoff and keeps the rest', () => {
    const plan = planRetention({ now: NOW, retentionMonths: 12, partitions });

    // 2025_08 ends on 2025-09-01, which is the cutoff: every row in it is at least twelve full
    // months old. 2025_09 ends a month later and still holds rows younger than that.
    expect(plan.detach).toEqual(['audit_logs_2025_07', 'audit_logs_2025_08']);
    expect(plan.keep).toEqual(['audit_logs_2025_09', 'audit_logs_2026_09', 'audit_logs_2026_11']);
  });

  it('never lists the DEFAULT partition on either side', () => {
    const plan = planRetention({ now: NOW, retentionMonths: 12, partitions });

    expect([...plan.detach, ...plan.keep]).not.toContain('audit_logs_default');
  });

  it('detaches nothing when retention is not configured', () => {
    const plan = planRetention({ now: NOW, retentionMonths: undefined, partitions });

    expect(plan.detach).toEqual([]);
    expect(plan.keep).toEqual([
      'audit_logs_2025_07',
      'audit_logs_2025_08',
      'audit_logs_2025_09',
      'audit_logs_2026_09',
      'audit_logs_2026_11',
    ]);
  });

  it('keeps a partition it cannot date rather than guessing', () => {
    const plan = planRetention({
      now: NOW,
      retentionMonths: 12,
      partitions: ['audit_logs_2020_01', 'audit_logs_archive'],
    });

    expect(plan.detach).toEqual(['audit_logs_2020_01']);
    expect(plan.keep).toEqual(['audit_logs_archive']);
  });
});

describe('the command line', () => {
  it('with no arguments plans a detach run', () => {
    expect(parseRetentionArguments([])).toEqual({ mode: 'detach' });
    expect(parseRetentionArguments(['--'])).toEqual({ mode: 'detach' });
  });

  it('--drop names the detached tables to remove, and requires at least one', () => {
    expect(parseRetentionArguments(['--drop', 'audit_logs_2025_07', 'audit_logs_2025_08'])).toEqual(
      { mode: 'drop', tables: ['audit_logs_2025_07', 'audit_logs_2025_08'] },
    );
    expect(parseRetentionArguments(['--drop'])).toMatchObject({ mode: 'error' });
  });

  it('--drop refuses a name that is not a dated audit partition', () => {
    // The DEFAULT partition is the one table this command must never remove, and a table of any
    // other family is not this command's business; both are refused before a connection is opened.
    expect(parseRetentionArguments(['--drop', 'audit_logs_default'])).toMatchObject({
      mode: 'error',
    });
    expect(parseRetentionArguments(['--drop', 'tasks'])).toMatchObject({ mode: 'error' });
  });

  it('refuses an argument it does not know', () => {
    expect(parseRetentionArguments(['--force'])).toMatchObject({ mode: 'error' });
  });
});

/**
 * The text the operator and the cron log act on. Every line of it carries a decision — which table
 * to back up, which one to drop, whether the DEFAULT partition is a problem — so a line that quietly
 * stops being printed is a decision nobody is told to make.
 */
describe('the report as the operator reads it', () => {
  const base: RetentionReport = {
    mode: 'detach',
    retentionMonths: 12,
    cutoff: '2025-09-01',
    detached: [],
    kept: [],
    awaitingDrop: [],
    dropped: [],
    failed: [],
    defaultPartition: { table: 'audit_logs_default', rows: 0 },
  };

  it('names the threshold, every detached month with its size, the failures and what awaits a drop', () => {
    const text = renderRetentionReport({
      ...base,
      detached: [{ table: 'audit_logs_2025_07', bytes: 18_948_096, durationMs: 1.04 }],
      kept: ['audit_logs_2025_09', 'audit_logs_2026_09'],
      awaitingDrop: ['audit_logs_2025_06'],
      failed: [{ table: 'audit_logs_2025_08', reason: 'lock timeout' }],
      defaultPartition: { table: 'audit_logs_default', rows: 42 },
    });

    expect(text).toBe(
      [
        'audit retention: 12 months, cutoff 2025-09-01',
        '  detached audit_logs_2025_07 (18948096 bytes, 1 ms) — back it up, then drop it',
        '  kept 2 attached partition(s)',
        '  FAILED audit_logs_2025_08: lock timeout',
        '  awaiting drop: audit_logs_2025_06 — detached earlier; confirm the backup, then pnpm db:audit-retention -- --drop <table>',
        '  WARNING audit_logs_default holds 42 row(s): a month had no partition when they were written — run pnpm db:audit-partitions and move them (docs/runbooks/audit-log.md); retention never touches this partition',
        '',
      ].join('\n'),
    );
  });

  it('says in the first line that retention is off when the variable is unset', () => {
    const text = renderRetentionReport({ ...base, retentionMonths: undefined, cutoff: undefined });

    expect(text.split('\n')[0]).toBe(
      'audit retention: AUDIT_RETENTION_MONTHS is not set — retention is off, nothing detached',
    );
    expect(text).toContain('  audit_logs_default: empty');
  });

  it('in drop mode lists what was dropped and what was refused, and nothing about a cutoff', () => {
    const text = renderRetentionReport({
      ...base,
      mode: 'drop',
      dropped: ['audit_logs_2025_06'],
      failed: [{ table: 'audit_logs_2025_09', reason: 'still attached' }],
    });

    expect(text).toBe(
      [
        '  dropped audit_logs_2025_06',
        '  FAILED audit_logs_2025_09: still attached',
        '  audit_logs_default: empty',
        '',
      ].join('\n'),
    );
  });
});

/**
 * Acceptance 4 of STORY-016-05: retention is an operation on partitions, never a statement over
 * rows. `DELETE FROM audit_logs` over a year of a busy installation is hours of locks and bloat
 * where a `DETACH` is a catalog change — and the privilege model already makes the statement
 * impossible for the application, so a copy of it in the tooling would be the only place it could
 * exist.
 *
 * `audit_logs\b` on purpose: `docs/runbooks/audit-log.md` moves rows out of `audit_logs_default`
 * with a `DELETE … RETURNING`, and that is the repair of a missed partition, not retention.
 */
describe('no code deletes rows of the audit trail', () => {
  const PACKAGE_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

  const sourcesUnder = (directory: string): string[] =>
    readdirSync(`${PACKAGE_ROOT}${directory}`, { withFileTypes: true }).flatMap((entry) => {
      const path = `${directory}/${entry.name}`;

      if (entry.isDirectory()) return sourcesUnder(path);

      return /\.(ts|sql)$/.test(entry.name) ? [path] : [];
    });

  it('neither in src, nor in scripts, nor in a migration', () => {
    const offenders = ['/src', '/scripts', '/prisma']
      .flatMap((directory) => sourcesUnder(directory))
      .filter((path) =>
        /DELETE\s+FROM\s+"?audit_logs\b/i.test(readFileSync(`${PACKAGE_ROOT}${path}`, 'utf8')),
      );

    expect(offenders).toEqual([]);
  });
});
