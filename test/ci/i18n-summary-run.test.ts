/**
 * The entry point of `pnpm i18n:check`: the filesystem around the arithmetic.
 *
 * `i18n-summary.test.ts` proves the counting on catalogues written for the test. This file proves
 * the part that only exists once — that it reads the tree this repository actually ships, that it
 * writes where the workflow expects to find the table, and that it does not fall over when there is
 * no workflow to write to. Those three are exactly what a unit test on the util cannot say.
 */
/*
 * The ban on `node:fs` exists so that every **repository** file a test reads goes through
 * `readRepoFile` and stays hashed by `//#test:repo`. Nothing here touches the repository: the three
 * calls create a file in the system temp directory, write to it and read it back, standing in for
 * the job summary a workflow provides. Recording a path that changes on every run would make that
 * audit lie in the other direction.
 */
// eslint-disable-next-line no-restricted-imports -- temp files only, never a repository path
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { run } from '../../scripts/ci/i18n-summary.js';

const silently = <T>(body: () => T): T => {
  const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

  try {
    return body();
  } finally {
    write.mockRestore();
  }
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('pnpm i18n:check', () => {
  it("passes on this repository's own catalogues", () => {
    vi.stubEnv('GITHUB_STEP_SUMMARY', '');

    expect(silently(run)).toBe(0);
  });

  it('prints the table', () => {
    vi.stubEnv('GITHUB_STEP_SUMMARY', '');
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    let printed = '';
    write.mockImplementation((chunk) => {
      printed += String(chunk);
      return true;
    });

    try {
      run();
    } finally {
      write.mockRestore();
    }

    expect(printed).toContain('## Translations');
    expect(printed).toContain('| Language | Keys | Untranslated |');
  });

  /**
   * Where the workflow looks for it. Asserted by writing to a real file rather than by spying on
   * `appendFileSync`, because the failure this guards against is the path being read from the wrong
   * variable — a spy on the writer would happily record a call to nowhere.
   */
  it('appends the table to the job summary when the workflow provides one', () => {
    const summaryPath = join(mkdtempSync(join(tmpdir(), 'i18n-summary-')), 'summary.md');
    writeFileSync(summaryPath, '# existing\n', 'utf8');
    vi.stubEnv('GITHUB_STEP_SUMMARY', summaryPath);

    silently(run);

    const written = readFileSync(summaryPath, 'utf8');
    expect(written).toContain('# existing');
    expect(written).toContain('| Language | Keys | Untranslated |');
  });

  it('writes nothing anywhere when it is run outside a workflow', () => {
    vi.stubEnv('GITHUB_STEP_SUMMARY', '');

    // The assertion is that this does not throw: an unset variable used as a path is the classic
    // way a summary step turns a green check into an unhandled `ENOENT` on a developer's machine.
    expect(() => silently(run)).not.toThrow();
  });
});
