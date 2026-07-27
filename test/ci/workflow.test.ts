import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

import { readJson, readRepoFile } from '../repo/repo-fixture.util.js';

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  if?: string;
  'continue-on-error'?: boolean;
}

interface WorkflowJob {
  'runs-on'?: string;
  'timeout-minutes'?: number;
  needs?: string | string[];
  strategy?: { matrix?: Record<string, unknown> };
  steps?: WorkflowStep[];
}

interface Workflow {
  name?: string;
  on?: {
    pull_request?: unknown;
    push?: { branches?: string[] };
    schedule?: unknown;
  };
  permissions?: Record<string, string>;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean | string };
  jobs?: Record<string, WorkflowJob>;
}

const WORKFLOW_PATH = '.github/workflows/ci.yml';

const workflowSource = (): string => readRepoFile(WORKFLOW_PATH);
const workflow = (): Workflow => parseYaml(workflowSource()) as Workflow;

const jobs = (): [string, WorkflowJob][] => Object.entries(workflow().jobs ?? {});
const steps = (): WorkflowStep[] => jobs().flatMap(([, job]) => job.steps ?? []);

/** Every `run:` body in the workflow, as one searchable haystack per step. */
const runScripts = (): string[] =>
  steps().flatMap((step) => (step.run === undefined ? [] : [step.run]));

const someRunMatches = (pattern: RegExp): boolean => runScripts().some((run) => pattern.test(run));

/**
 * The task list of `rules/ci-before-push.mdc`, read out of the rule rather than repeated here.
 *
 * The rule is the contract: whatever a contributor has to run before pushing is exactly what CI
 * has to run on the pull request. Copying the list into this file would let the two drift the day
 * someone adds a task to the rule — the failure this test exists to prevent.
 */
const taskSetOfTheRule = (): string[] => {
  const rule = readRepoFile('rules/ci-before-push.mdc');
  const match = /pnpm turbo run ([a-z:\-\s]+?)\n/.exec(rule);

  expect(
    match,
    'rules/ci-before-push.mdc no longer states a `pnpm turbo run …` command',
  ).not.toBeNull();

  return (match as RegExpExecArray)[1].trim().split(/\s+/);
};

/** The tasks a `turbo run` command line asks for: everything up to the first flag. */
const tasksOf = (command: string): string[] => {
  const match = /turbo run ([^\n|&]*)/.exec(command);
  if (match === null) return [];

  return match[1]
    .trim()
    .split(/\s+/)
    .filter((token) => !token.startsWith('-'));
};

describe('CI workflow exists and is triggered where it matters', () => {
  it('is valid YAML with a name', () => {
    expect(workflow().name).toBeTruthy();
  });

  it('runs on every pull request', () => {
    expect(workflow().on).toHaveProperty('pull_request');
  });

  it('runs on push to main, so the branch that gates merges is itself measured', () => {
    expect(workflow().on?.push?.branches).toEqual(['main']);
  });

  it('declares at least one job', () => {
    expect(jobs().length).toBeGreaterThan(0);
  });
});

/**
 * `rules/ci-before-push.mdc`: one command, the full set, from the repository root. A CI that runs a
 * hand-written sequence of `pnpm typecheck && pnpm lint && …` instead is a CI that can silently
 * diverge from what contributors run locally — and the divergence only ever surfaces as "green
 * locally, red on main", which is the failure mode the rule was written to remove.
 */
describe('CI runs exactly the CI-before-push task set', () => {
  const turboSteps = (): string[] => runScripts().filter((run) => run.includes('turbo run'));

  it('invokes turbo rather than the individual package scripts', () => {
    expect(turboSteps().length).toBeGreaterThan(0);
  });

  /**
   * Compared as sets: `compat` runs the same command on a newer Node, so every task legitimately
   * appears twice. What must not drift is *which* tasks CI runs versus which the rule demands.
   */
  it('asks turbo for the same tasks the rule requires before a push', () => {
    const required = new Set(taskSetOfTheRule());
    const covered = new Set(turboSteps().flatMap((run) => tasksOf(run)));

    expect([...covered].sort()).toEqual([...required].sort());
  });

  it('installs with a frozen lockfile, so a stale lock fails instead of being rewritten', () => {
    expect(someRunMatches(/pnpm install .*--frozen-lockfile/)).toBe(true);
  });
});

describe('toolchain versions come from the repository, not from the workflow', () => {
  const setupNodeSteps = (): WorkflowStep[] =>
    steps().filter((step) => step.uses?.startsWith('actions/setup-node') === true);

  it('sets up Node in the workflow', () => {
    expect(setupNodeSteps().length).toBeGreaterThan(0);
  });

  /**
   * Every job except `compat`. That one exists precisely to run on a Node the repository does *not*
   * pin — it checks the claim `engines.node` makes about versions above the floor, which is what
   * `.nvmrc` cannot express. Reading `.nvmrc` there would make the job a duplicate of `checks`.
   */
  it('takes the Node version from .nvmrc everywhere except the compatibility job', () => {
    for (const [name, job] of jobs()) {
      if (name === 'compat') continue;

      for (const step of (job.steps ?? []).filter((candidate) =>
        candidate.uses?.startsWith('actions/setup-node'),
      )) {
        expect(step.with?.['node-version-file'], name).toBe('.nvmrc');
        expect(
          step.with?.['node-version'],
          `${name}: a pinned version shadows .nvmrc`,
        ).toBeUndefined();
      }
    }
  });

  it('pins an explicit newer Node in the compatibility job, from a matrix', () => {
    const compat = jobs().find(([name]) => name === 'compat')?.[1];

    expect(compat, 'the compat job is what tests the open-ended engines range').toBeDefined();
    expect(compat?.strategy?.matrix?.node).toBeDefined();
  });

  /**
   * The literal check catches the copy `node-version-file` cannot: a `NODE_VERSION: 22.22.1` env,
   * a container tag, a comment that says 22 and stops being true. `.nvmrc` is bumped by one line;
   * every other mention of that number is a second source of truth.
   */
  it('never repeats the .nvmrc version anywhere in the workflow', () => {
    const version = readRepoFile('.nvmrc').trim();

    expect(workflowSource()).not.toContain(version);
  });

  it('activates pnpm through Corepack, which reads packageManager from package.json', () => {
    expect(someRunMatches(/corepack enable/)).toBe(true);
  });

  it('never repeats the packageManager version anywhere in the workflow', () => {
    const packageManager = /"packageManager":\s*"pnpm@([\d.]+)"/.exec(readRepoFile('package.json'));

    expect(packageManager).not.toBeNull();
    expect(workflowSource()).not.toContain((packageManager as RegExpExecArray)[1]);
  });
});

/** Epic acceptance: a pull request that touches no heavy package finishes inside ten minutes. */
describe('caches', () => {
  const cacheSteps = (): WorkflowStep[] =>
    steps().filter((step) => step.uses?.startsWith('actions/cache') === true);

  const cachedPaths = (): string =>
    cacheSteps()
      .map((step) => String(step.with?.path ?? ''))
      .join('\n');

  it('caches the pnpm store between runs', () => {
    expect(cachedPaths()).toMatch(/store|STORE_PATH/);
  });

  it('caches the turbo filesystem cache between runs', () => {
    expect(cachedPaths()).toContain('.turbo/cache');
  });

  it('gives every cache a restore-keys prefix, so a new commit still starts warm', () => {
    for (const step of cacheSteps()) {
      expect(step.with?.['restore-keys'], String(step.name)).toBeTruthy();
    }
  });
});

describe('the scanners are a gate, not a report', () => {
  const scanSteps = (): WorkflowStep[] =>
    steps().filter(
      (step) => /gitleaks/i.test(step.name ?? '') || /gitleaks|scan-cruft/.test(step.run ?? ''),
    );

  it('scans for secrets and for cruft', () => {
    expect(someRunMatches(/gitleaks/)).toBe(true);
    expect(someRunMatches(/scan-cruft/)).toBe(true);
  });

  /**
   * `continue-on-error` on a scanner turns a blocking gate into a decoration: the step goes red,
   * the job stays green and the pull request merges. STORY-002-04 is the requirement that a found
   * secret *blocks*.
   */
  it('lets no step continue on error', () => {
    for (const step of steps()) {
      expect(step['continue-on-error'], String(step.name ?? step.uses ?? step.run)).not.toBe(true);
    }
  });

  it('runs the scanners in a job of their own, so a failing test cannot skip them', () => {
    expect(scanSteps().length).toBeGreaterThan(0);
    const scanJobs = jobs().filter(([, job]) =>
      (job.steps ?? []).some((step) => /gitleaks|scan-cruft/.test(step.run ?? '')),
    );

    for (const [, job] of scanJobs) {
      expect(job.needs ?? []).toEqual([]);
    }
  });

  it('pins the gitleaks version instead of following a moving tag', () => {
    expect(workflowSource()).toMatch(/GITLEAKS_VERSION:\s*['"]?\d+\.\d+\.\d+/);
  });

  it('verifies the checksum of the downloaded scanner', () => {
    expect(someRunMatches(/sha256sum|shasum/)).toBe(true);
  });
});

describe('coverage leaves the run as evidence', () => {
  it('uploads the coverage reports even when the job failed', () => {
    const uploads = steps().filter(
      (step) => step.uses?.startsWith('actions/upload-artifact') === true,
    );
    const coverageUploads = uploads.filter((step) =>
      String(step.with?.path ?? '').includes('coverage'),
    );

    expect(coverageUploads.length).toBeGreaterThan(0);
    for (const step of coverageUploads) {
      expect(step.if, 'a coverage upload that only runs on success is evidence of nothing').toMatch(
        /always\(\)|failure\(\)/,
      );
    }
  });

  it('compares the run against the committed coverage baseline', () => {
    expect(someRunMatches(/coverage[:-]baseline/)).toBe(true);
  });

  /**
   * The comparison runs through a root script, not through a command spelled out in the workflow:
   * a contributor has to be able to run the same check locally, and a check only CI knows how to
   * invoke is a check nobody runs before pushing.
   */
  it('backs that comparison with a root script over a committed baseline file', () => {
    const { scripts } = readJson<{ scripts?: Record<string, string> }>('package.json');

    expect(scripts?.['coverage:baseline']).toContain('scripts/ci/coverage-baseline.ts');
    expect(readRepoFile('coverage-baseline.json')).toBeTruthy();
  });
});

describe('workflow hardening', () => {
  it('grants read-only repository access by default', () => {
    expect(workflow().permissions).toEqual({ contents: 'read' });
  });

  it('cancels a superseded run on the same ref', () => {
    const concurrency = workflow().concurrency;

    expect(concurrency?.group).toContain('github.ref');
    expect(concurrency?.['cancel-in-progress']).toBeDefined();
  });

  it('bounds every job with a timeout', () => {
    for (const [name, job] of jobs()) {
      expect(job['timeout-minutes'], name).toBeGreaterThan(0);
    }
  });

  /**
   * A tag is a mutable pointer: `@v7` is whatever the action's owner force-pushes it to. Pinning to
   * the commit is the only form of pinning that survives a compromised maintainer account, which is
   * how the Actions supply chain has actually been attacked.
   */
  it('pins every action to a commit SHA', () => {
    for (const step of steps()) {
      if (step.uses === undefined) continue;
      expect(step.uses, String(step.name)).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it('names the human-readable version beside every pinned SHA', () => {
    for (const line of workflowSource().split('\n')) {
      if (!line.includes('uses:')) continue;
      expect(line, line.trim()).toMatch(/#\s*v\d+\.\d+\.\d+/);
    }
  });

  /**
   * No OS matrix on purpose: the product ships as a Linux container and is installed with
   * `docker compose`, so a macOS or Windows leg would triple the minutes and the wall clock while
   * testing a platform nothing runs on.
   */
  it('runs every job on Linux, without an OS matrix', () => {
    for (const [name, job] of jobs()) {
      expect(job['runs-on'], name).toMatch(/^ubuntu-/);
      expect(job.strategy?.matrix?.os, name).toBeUndefined();
    }
  });
});

/**
 * Everything above proves the workflow *runs* the gates. Nothing proved that a gate which fires
 * actually stops the merge — and that is the half a mistake lands in. Four mutations that disable
 * the pipeline entirely passed the whole suite before these tests existed:
 *
 *   - the cruft scanner invoked with `--staged` instead of `--diff` (a fresh CI checkout has an
 *     empty index, so the scanner reads nothing and reports success on every run);
 *   - `[ "$status" -ge 2 ]` widened to `-ge 3`, so the blocking tier stops blocking;
 *   - the secret scanner's finding code no longer mapped to a failure;
 *   - `|| true` appended to the coverage step.
 *
 * Each is one character to make and invisible in review. These assertions read the wiring itself.
 */
describe('a gate that fires actually fails the job', () => {
  const stepRunning = (pattern: RegExp): string => {
    const found = runScripts().find((run) => pattern.test(run));

    expect(found, `no step runs ${pattern}`).toBeDefined();
    return found as string;
  };

  it('feeds the cruft scanner the diff, not the index', () => {
    const step = stepRunning(/scan-cruft\.ts/);

    expect(step).toMatch(/scan-cruft\.ts\s+--diff\b/);
    // `--staged` reads `git diff --cached`, which is empty in a CI checkout: the scanner would
    // find nothing to look at and exit 0 on every run.
    expect(step).not.toMatch(/scan-cruft\.ts\s+--staged\b/);
    expect(step).toMatch(/<\s*"\$RUNNER_TEMP\/diff\.patch"/);
  });

  it('treats the cruft scanner blocking tier as a failure', () => {
    // The scanner exits 2 for the blocking tier and 1 for the advisory one. The comparison has to
    // be against 2: raising it to 3 leaves the step green on exactly the findings that matter.
    expect(stepRunning(/scan-cruft\.ts/)).toMatch(
      /\[\s*"\$status"\s+-ge\s+2\s*\]\s*;\s*then\s+exit\s+1/,
    );
  });

  it('treats a secret-scanner finding as a failure', () => {
    const step = stepRunning(/gitleaks" git \./);

    expect(step).toMatch(/--exit-code\s+2/);
    expect(step).toMatch(/-eq\s+2/);
    expect(step).toMatch(/exit\s+1/);
  });

  it.each([
    ['cruft scan', /scan-cruft\.ts/],
    ['secret scan', /gitleaks" git \./],
    ['coverage baseline', /coverage:baseline/],
  ])('does not silence the %s step', (_name, pattern) => {
    // `|| true`, `|| :` and `continue-on-error` all turn a red gate green without touching the
    // gate itself, which is why they are checked at the step that carries the gate.
    const step = stepRunning(pattern);

    // Not anchored to end of line on purpose: `|| true &&` in the middle of a chain silences the
    // command just as completely as a trailing one, and reads as harmless in a diff.
    expect(step).not.toMatch(/\|\|\s*(true|:)\b/);
    expect(step).not.toMatch(/\bset\s+\+e\b(?![\s\S]*\bset\s+-e\b)/);

    const owner = steps().find((candidate) => pattern.test(candidate.run ?? ''));
    expect(owner?.['continue-on-error']).toBeUndefined();
  });
});
