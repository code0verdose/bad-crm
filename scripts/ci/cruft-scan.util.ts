/**
 * The cruft gate of STORY-002-04, as repository code.
 *
 * The pattern set is the one `rules/commit-hygiene.mdc` describes and the maintainer's personal
 * `~/.claude/security/scan-cruft.sh` implements. That script cannot be the CI gate: it lives in a
 * home directory no runner has and no contributor clones, so a repository that relies on it has a
 * rule enforced on exactly one machine. The husky `pre-commit` hook does not close the gap either —
 * it delegates to an *untracked* `.git/hooks/pre-commit.local`, which a fork simply does not have,
 * and `--no-verify` skips it in any case.
 *
 * ESLint covers part of the same ground (`no-debugger`, `vitest/no-focused-tests`) and stays the
 * first line: it is type-aware, it runs on every file of every package and it fixes what it can.
 * It cannot express the rest of the requirement, though. `--max-warnings 0` means ESLint has one
 * severity that matters, while the story asks for two outcomes — a `debugger` must block the merge,
 * a `TODO` must be visible to the reviewer without stopping the pipeline — and neither markdown,
 * YAML nor SQL is linted at all, which is where conflict markers and pasted `localhost` URLs
 * actually survive review.
 *
 * Scope: added lines of a diff. A finding on a line the change did not write is somebody else's
 * commit, and a gate that reports it teaches contributors to ignore the gate.
 */

export type Tier = 'BLOCK' | 'WARN';

export interface Finding {
  readonly tier: Tier;
  readonly rule: string;
  /** The matched text. Reported to the terminal, never to the public job summary. */
  readonly match: string;
  readonly file: string;
  /** 1-based line number in the new file, so `file:line` opens on the offending line. */
  readonly line: number;
}

interface Pattern {
  readonly rule: string;
  readonly pattern: RegExp;
}

/**
 * High confidence: none of these has a legitimate reason to enter the default branch.
 *
 * The negative lookbehind on `debugger` is what keeps `'no-debugger': 'error'` — the ESLint rule
 * that forbids it — from being reported as the thing it forbids.
 */
const BLOCK: readonly Pattern[] = [
  { rule: 'debugger statement', pattern: /(?<![-\w])debugger\b/g },
  {
    rule: 'focused or skipped test',
    pattern: /\b(?:describe|it|test|context)\.only\s*\(|\b(?:fit|fdescribe|xit|xdescribe)\s*\(/g,
  },
  {
    rule: 'debug breakpoint',
    pattern: /\b(?:binding\.pry|byebug|debug\.set_trace|pdb\.set_trace|dd\(|var_dump\()/g,
  },
  { rule: 'merge conflict marker', pattern: /^(?:<{7}|={7}|>{7})(?:\s|$)/g },
];

/** Worth a second look, not worth stopping a pipeline for. */
const WARN: readonly Pattern[] = [
  { rule: 'TODO/FIXME/HACK', pattern: /\b(?:TODO|FIXME|HACK|XXX)\b/g },
  {
    rule: 'debug print',
    pattern: /console\.(?:log|debug|trace)\s*\(|(?<![\w.])print\s*\(|fmt\.Print/g,
  },
  {
    rule: 'localhost or test endpoint',
    pattern: /https?:\/\/(?:localhost|127\.0\.0\.1)|\.ngrok\.|:3000\b|:8080\b/g,
  },
  {
    // `sk_test_` is a prefix, so it is followed by the key itself and never by a word boundary —
    // `\b` after it would match the literal string and miss every real occurrence.
    rule: 'test or placeholder key',
    pattern: /\b(?:sk_test_|pk_test_)\w*|\b(?:test_api_key|changeme|placeholder)\b/gi,
  },
  {
    rule: 'mock or sample data',
    pattern: /\b(?:dummy|foobar|deadbeef|lorem\s+ipsum|john\s+doe|example\.com)\b/gi,
  },
];

const TIERS: readonly (readonly [Tier, readonly Pattern[]])[] = [
  ['BLOCK', BLOCK],
  ['WARN', WARN],
];

/**
 * The rules that fire on one line of one file, in tier order — each rule at most once.
 *
 * One rule matching twice on a line (`http://localhost:3000` is both a localhost URL and a
 * development port) is one thing to fix, and reporting it twice makes a summary longer without
 * making it more useful.
 */
const scanLine = (content: string, file: string, line: number): Finding[] =>
  TIERS.flatMap(([tier, patterns]) =>
    patterns.flatMap((entry) => {
      const match = entry.pattern.exec(content);
      entry.pattern.lastIndex = 0;

      return match === null ? [] : [{ tier, rule: entry.rule, match: match[0], file, line }];
    }),
  );

/** Characters that are literal in a `.cruftignore` glob but special in a regular expression. */
const ESCAPED = /[.+^${}()|[\]\\]/g;

/**
 * `.cruftignore` globs, with the semantics the file was written against: the shell `case`
 * statement of the original scanner, where `*` crosses directory separators. That is why `epics/*`
 * covers `epics/epic-002-ci/stories/story-002-04.md` — and why an entry has to be read as "this
 * subtree", not "these files".
 */
const globToRegExp = (pattern: string): RegExp =>
  new RegExp(
    `^${pattern
      .replace(ESCAPED, String.raw`\$&`)
      .replaceAll('*', '.*')
      .replaceAll('?', '.')}$`,
  );

export const isIgnored = (file: string, patterns: readonly string[]): boolean =>
  patterns.some((pattern) => globToRegExp(pattern).test(file));

/** The non-empty, non-comment lines of a `.cruftignore`. */
export const parseIgnorePatterns = (source: string): string[] =>
  source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

const NEW_FILE = /^\+\+\+ (?:b\/)?(.+)$/;
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Scans the added lines of a unified diff.
 *
 * Line numbers come from the hunk headers rather than from counting the patch: a reviewer needs
 * `file:line` of the file, and the two differ by every context and removed line before them.
 */
export const scanDiff = (diff: string, ignorePatterns: readonly string[]): Finding[] => {
  const findings: Finding[] = [];
  let file: string | undefined;
  let ignored = false;
  let line = 0;

  for (const raw of diff.split('\n')) {
    const header = NEW_FILE.exec(raw);

    if (header !== null) {
      // `+++ /dev/null` is a deletion: there is no new file, and nothing was added to scan.
      file = header[1] === '/dev/null' ? undefined : header[1];
      ignored = file !== undefined && isIgnored(file, ignorePatterns);
      continue;
    }

    const hunk = HUNK.exec(raw);

    if (hunk !== null) {
      line = Number(hunk[1]);
      continue;
    }

    if (file === undefined) continue;

    if (raw.startsWith('+')) {
      if (!ignored) findings.push(...scanLine(raw.slice(1), file, line));
      line += 1;
      continue;
    }

    // A context line advances the new-file counter; a removed line does not exist in it.
    if (raw.startsWith(' ')) line += 1;
  }

  return findings;
};

/** 0 — clean, 1 — warnings only, 2 — at least one blocking finding. */
export const exitCodeOf = (findings: readonly Finding[]): 0 | 1 | 2 => {
  if (findings.some((finding) => finding.tier === 'BLOCK')) return 2;

  return findings.length > 0 ? 1 : 0;
};

const listOf = (findings: readonly Finding[]): string[] =>
  findings.map((finding) => `- \`${finding.file}:${finding.line}\` — ${finding.rule}`);

/**
 * The markdown the workflow appends to the job summary.
 *
 * The matched text is deliberately absent: a summary of a public repository is a public page, and
 * the `test or placeholder key` rule matches exactly the strings that must not be republished.
 * Rule plus location is enough to find the line in the diff.
 */
export const renderReport = (findings: readonly Finding[]): string => {
  if (findings.length === 0) return '### Cruft scan\n\nNo cruft in the added lines.';

  const blocking = findings.filter((finding) => finding.tier === 'BLOCK');
  const warnings = findings.filter((finding) => finding.tier === 'WARN');
  const lines = ['### Cruft scan', ''];

  if (blocking.length > 0) {
    lines.push('**Blocking** — remove before merging:', '', ...listOf(blocking), '');
  }

  if (warnings.length > 0) {
    lines.push(
      '**Warnings** — for the reviewer, not a build failure:',
      '',
      ...listOf(warnings),
      '',
    );
  }

  return lines.join('\n');
};
