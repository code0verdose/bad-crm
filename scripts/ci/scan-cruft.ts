/**
 * `pnpm scan:cruft` — the commit-hygiene gate of `rules/commit-hygiene.mdc`, over a diff.
 *
 * Two ways in, the same scanner behind both:
 *   `pnpm scan:cruft --staged`   what is about to be committed, for local use before `git commit`;
 *   `pnpm scan:cruft --diff`     a unified diff on stdin, which is how CI passes the pull request.
 *
 * Exit code 2 (blocking findings) is what the workflow turns into a red job; 1 (warnings only)
 * leaves the pipeline green and the findings in the job summary. The markdown report goes to
 * stdout so it can be appended to `$GITHUB_STEP_SUMMARY`; the terminal lines, which do include the
 * matched text, go to stderr and stay in the log the reader already has access to.
 *
 * The matching itself is in `cruft-scan.util.ts`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { exitCodeOf, parseIgnorePatterns, renderReport, scanDiff } from './cruft-scan.util.js';
import { isEntryPoint, repoRoot } from '../lib/repo-paths.util.js';

const readIgnorePatterns = (): string[] => {
  try {
    return parseIgnorePatterns(readFileSync(join(repoRoot, '.cruftignore'), 'utf8'));
  } catch {
    return [];
  }
};

const readDiff = (staged: boolean): string =>
  staged
    ? execFileSync('git', ['diff', '--cached', '--no-color'], { cwd: repoRoot, encoding: 'utf8' })
    : readFileSync(0, 'utf8');

if (isEntryPoint(import.meta.url)) {
  const findings = scanDiff(readDiff(process.argv.includes('--staged')), readIgnorePatterns());

  process.stdout.write(`${renderReport(findings)}\n`);

  for (const finding of findings) {
    const mark = finding.tier === 'BLOCK' ? 'blocking' : 'warning';

    process.stderr.write(
      `${mark}: ${finding.file}:${finding.line} — ${finding.rule} (${finding.match})\n`,
    );
  }

  process.exitCode = exitCodeOf(findings);
}
