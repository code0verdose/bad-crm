import type { CheckResult } from './service-check.types.js';

/**
 * Rendering and the verdict.
 *
 * The report is written for somebody whose stack just refused to start, so every failing line is
 * followed by the command that fixes it. A verdict without a next step sends the reader back to
 * reading YAML comments, which is the situation this script exists to end.
 */

export interface CheckSummary {
  readonly ok: number;
  readonly failed: number;
  readonly skipped: number;
  /** Only these decide the exit code. */
  readonly requiredFailures: number;
}

export const summarize = (results: readonly CheckResult[]): CheckSummary => ({
  ok: results.filter((result) => result.status === 'ok').length,
  failed: results.filter((result) => result.status === 'failed').length,
  skipped: results.filter((result) => result.status === 'skipped').length,
  requiredFailures: results.filter(
    (result) => result.status === 'failed' && result.requirement === 'required',
  ).length,
});

/**
 * A failed *optional* service is a warning, not a failure: the application is required to run
 * without Meilisearch, SMTP, AI and OTel (`stack.md`, «Деградация при отсутствии опционального
 * сервиса»). Failing the command on one of them would make the `minimal` profile permanently red.
 */
export const exitCodeFor = (results: readonly CheckResult[]): 0 | 1 =>
  summarize(results).requiredFailures > 0 ? 1 : 0;

const MARK: Record<CheckResult['status'], string> = {
  ok: 'OK     ',
  failed: 'FAILED ',
  skipped: 'SKIPPED',
};

export const renderReport = (results: readonly CheckResult[]): string => {
  const width = Math.max(...results.map((result) => result.service.length), 1);

  const lines = results.flatMap((result) => {
    const optional = result.requirement === 'optional' ? ' (optional)' : '';
    const head = `  ${MARK[result.status]}  ${result.service.padEnd(width)}  ${result.target}${optional}`;
    const details = result.details.map((detail) => `           · ${detail}`);
    const remedy = result.remedy === undefined ? [] : [`           → ${result.remedy}`];

    return [head, ...details, ...remedy];
  });

  const summary = summarize(results);

  return [
    ...lines,
    '',
    `  ${summary.ok} ok, ${summary.failed} failed, ${summary.skipped} skipped`,
    '',
  ].join('\n');
};
