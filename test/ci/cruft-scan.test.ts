import { describe, expect, it } from 'vitest';

import {
  exitCodeOf,
  isIgnored,
  parseIgnorePatterns,
  renderReport,
  scanDiff,
  type Finding,
} from '../../scripts/ci/cruft-scan.util.js';
import { readRepoFile } from '../repo/repo-fixture.util.js';

/** A minimal unified diff: one added line in one file. */
const diffAdding = (file: string, ...lines: string[]): string =>
  [
    `diff --git a/${file} b/${file}`,
    '--- /dev/null',
    `+++ b/${file}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join('\n');

const rulesFound = (diff: string): string[] => scanDiff(diff, []).map((finding) => finding.rule);

describe('what blocks a pull request', () => {
  it.each([
    ['a debugger statement', 'if (x) { debugger; }'],
    ['a focused suite', "describe.only('tasks', () => {});"],
    ['a focused spec', "it.only('creates a task', () => {});"],
    ['the jasmine spelling of a focused spec', "fit('creates a task', () => {});"],
    ['a skipped spec left behind', "xit('creates a task', () => {});"],
  ])('blocks %s', (_case, line) => {
    const findings = scanDiff(diffAdding('packages/server/src/task.ts', line), []);

    expect(findings.map((finding) => finding.tier)).toContain('BLOCK');
    expect(exitCodeOf(findings)).toBe(2);
  });

  it('blocks a merge conflict marker', () => {
    const findings = scanDiff(
      diffAdding('packages/server/src/task.ts', '<'.repeat(7) + ' HEAD'),
      [],
    );

    expect(exitCodeOf(findings)).toBe(2);
  });

  /**
   * The ESLint rule is spelled `no-debugger`, and the word `debugger` appears in every config and
   * every rule document that forbids it. A scanner that cannot tell the prohibition from the
   * offence is a scanner the project turns off within a week.
   */
  it('does not mistake the name of the lint rule for the statement', () => {
    expect(rulesFound(diffAdding('eslint.config.js', "  'no-debugger': 'error',"))).toEqual([]);
  });
});

describe('what only warns', () => {
  it.each([
    ['a TODO', '// TODO: split this use-case'],
    ['a debug print', 'console.log(task);'],
    ['a hardcoded local endpoint', "const api = 'http://localhost:3000';"],
    ['a placeholder key', "const key = 'sk_test_51H';"],
    ['sample data', "const owner = 'John Doe';"],
  ])('warns about %s without blocking', (_case, line) => {
    const findings = scanDiff(diffAdding('packages/server/src/task.ts', line), []);

    expect(findings.map((finding) => finding.tier)).toEqual(['WARN']);
    expect(exitCodeOf(findings)).toBe(1);
  });

  it('reports nothing for a clean change', () => {
    const findings = scanDiff(diffAdding('packages/server/src/task.ts', 'export const x = 1;'), []);

    expect(findings).toEqual([]);
    expect(exitCodeOf(findings)).toBe(0);
  });
});

describe('reading the diff', () => {
  it('ignores removed lines: deleting a debug statement is the fix, not the offence', () => {
    const diff = [
      'diff --git a/src/task.ts b/src/task.ts',
      '--- a/src/task.ts',
      '+++ b/src/task.ts',
      '@@ -1,2 +1,1 @@',
      '-console.log(task);',
      ' export const x = 1;',
    ].join('\n');

    expect(scanDiff(diff, [])).toEqual([]);
  });

  it('ignores the diff header of a file whose name contains a pattern', () => {
    const diff = [
      'diff --git a/src/debugger.ts b/src/debugger.ts',
      '--- a/src/debugger.ts',
      '+++ b/src/debugger.ts',
      '@@ -0,0 +1,1 @@',
      '+export const x = 1;',
    ].join('\n');

    expect(scanDiff(diff, [])).toEqual([]);
  });

  it('names the file and the line number of the new file, not the offset in the patch', () => {
    const diff = [
      'diff --git a/src/task.ts b/src/task.ts',
      '--- a/src/task.ts',
      '+++ b/src/task.ts',
      '@@ -40,3 +40,4 @@',
      ' const a = 1;',
      ' const b = 2;',
      '+console.log(a);',
    ].join('\n');

    expect(scanDiff(diff, [])[0]).toMatchObject({ file: 'src/task.ts', line: 42 });
  });

  it('keeps counting across hunks of the same file', () => {
    const diff = [
      'diff --git a/src/task.ts b/src/task.ts',
      '--- a/src/task.ts',
      '+++ b/src/task.ts',
      '@@ -1,1 +1,1 @@',
      ' const a = 1;',
      '@@ -80,1 +90,2 @@',
      ' const b = 2;',
      '+console.log(b);',
    ].join('\n');

    expect(scanDiff(diff, [])[0]?.line).toBe(91);
  });

  it('attributes findings to the right file when the diff spans several', () => {
    const diff = [
      diffAdding('a.ts', 'export const a = 1;'),
      diffAdding('b.ts', 'console.log(1);'),
    ].join('\n');

    expect(scanDiff(diff, []).map((finding) => finding.file)).toEqual(['b.ts']);
  });

  it('does not read a deleted file as an addition', () => {
    const diff = [
      'diff --git a/src/task.ts b/src/task.ts',
      '--- a/src/task.ts',
      '+++ /dev/null',
      '@@ -1,1 +0,0 @@',
      '-console.log(1);',
    ].join('\n');

    expect(scanDiff(diff, [])).toEqual([]);
  });
});

describe('.cruftignore', () => {
  it('drops findings under an ignored path', () => {
    const diff = diffAdding('rules/testing.mdc', 'Никогда не оставляй `debugger` в коде.');

    expect(scanDiff(diff, ['rules/*.mdc'])).toEqual([]);
  });

  it('keeps findings in code, whatever the documentation is allowed to say', () => {
    const diff = diffAdding('packages/server/src/task.ts', 'debugger;');

    expect(scanDiff(diff, ['rules/*.mdc'])).not.toEqual([]);
  });

  it.each([
    ['epics/*', 'epics/epic-002-ci/stories/story-002-04.md', true],
    ['docs/*', 'docs/runbooks/install.md', true],
    ['docs/*', 'packages/server/docs/note.md', false],
    ['README.md', 'README.md', true],
    ['README.md', 'docs/README.md', false],
  ])('pattern %s over %s', (pattern, path, expected) => {
    expect(isIgnored(path, [pattern])).toBe(expected);
  });

  it('skips blank lines and comments when reading the file', () => {
    expect(parseIgnorePatterns('# a comment\n\n  rules/*.mdc  \n')).toEqual(['rules/*.mdc']);
  });

  /**
   * The scanner's own source spells every forbidden pattern out as a regular expression, and so
   * does its suite. Without the exemption, the first pull request to touch either of them blocks
   * itself — and the fix a hurried contributor reaches for is deleting the scanner step.
   */
  it.each(['scripts/ci/cruft-scan.util.ts', 'test/ci/cruft-scan.test.ts'])(
    'exempts %s, which quotes every pattern verbatim',
    (path) => {
      expect(isIgnored(path, parseIgnorePatterns(readRepoFile('.cruftignore')))).toBe(true);
    },
  );

  it('never exempts the implementation', () => {
    const patterns = parseIgnorePatterns(readRepoFile('.cruftignore'));

    expect(isIgnored('packages/server/src/task.ts', patterns)).toBe(false);
    expect(isIgnored('packages/client/src/pages/board/page.tsx', patterns)).toBe(false);
  });
});

describe('the report', () => {
  const findings: Finding[] = [
    { tier: 'BLOCK', rule: 'debugger statement', match: 'debugger', file: 'a.ts', line: 3 },
    { tier: 'WARN', rule: 'TODO/FIXME/HACK', match: 'TODO', file: 'b.ts', line: 9 },
  ];

  it('separates what blocks from what merely warns', () => {
    const report = renderReport(findings);

    expect(report).toContain('Blocking');
    expect(report).toContain('Warnings');
  });

  it('locates every finding as file and line', () => {
    expect(renderReport(findings)).toContain('a.ts:3');
    expect(renderReport(findings)).toContain('b.ts:9');
  });

  it('says so when there is nothing to report', () => {
    expect(renderReport([])).toContain('No cruft');
  });

  /**
   * The job summary is a public artefact of a public repository. Printing the matched text of a
   * `sk_test_…`-shaped finding would republish it; the rule name and the location are enough to
   * find it in the diff.
   */
  it('names the rule and the location without quoting the matched text', () => {
    const secretish: Finding[] = [
      {
        tier: 'WARN',
        rule: 'test/placeholder key',
        match: 'sk_test_51HxYz',
        file: 'c.ts',
        line: 1,
      },
    ];

    expect(renderReport(secretish)).not.toContain('51HxYz');
    expect(renderReport(secretish)).toContain('test/placeholder key');
  });
});

describe('exit codes', () => {
  it('is 0 for a clean diff, 1 for warnings, 2 for a blocking finding', () => {
    const warn: Finding = { tier: 'WARN', rule: 'r', match: 'm', file: 'f', line: 1 };
    const block: Finding = { tier: 'BLOCK', rule: 'r', match: 'm', file: 'f', line: 1 };

    expect(exitCodeOf([])).toBe(0);
    expect(exitCodeOf([warn])).toBe(1);
    expect(exitCodeOf([warn, block])).toBe(2);
  });
});
