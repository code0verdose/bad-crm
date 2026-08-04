import { describe, expect, it } from 'vitest';

import { configForRepoFile, lintFixture } from './eslint-fixture.util.js';

/**
 * Every case is a file in `test/lint/fixtures/` that violates one architectural invariant, plus the
 * rule that has to catch it. A rule silently dropped from `eslint.config.js` fails here instead of
 * leaking into the codebase for months (STORY-001-03).
 */
interface ForbiddenCase {
  readonly fixture: string;
  readonly rule: string;
  /** Substring the operator-facing message must contain, so the error explains where to look. */
  readonly hint: string;
}

const PACKAGE_BOUNDARIES: ForbiddenCase[] = [
  {
    fixture: 'packages/shared/src/cross-package.util.ts',
    rule: 'no-restricted-imports',
    hint: 'shared',
  },
  {
    fixture: 'packages/client/src/shared/lib/cross-package.util.ts',
    rule: 'no-restricted-imports',
    hint: 'client',
  },
  {
    fixture: 'packages/server/src/domain/task/cross-package.value.ts',
    rule: 'no-restricted-imports',
    hint: 'server',
  },
  {
    fixture: 'packages/e2e/src/app-source.spec.ts',
    rule: 'no-restricted-imports',
    hint: 'e2e',
  },
];

const HEXAGONAL_LAYERS: ForbiddenCase[] = [
  {
    fixture: 'packages/server/src/domain/task/prisma.entity.ts',
    rule: 'no-restricted-imports',
    hint: 'hexagonal-backend',
  },
  {
    fixture: 'packages/server/src/domain/task/io.entity.ts',
    rule: 'no-restricted-imports',
    hint: 'hexagonal-backend',
  },
  {
    fixture: 'packages/server/src/application/task/use-cases/infra.use-case.ts',
    rule: 'no-restricted-imports',
    hint: 'hexagonal-backend',
  },
  {
    fixture: 'packages/server/src/application/task/use-cases/prisma.use-case.ts',
    rule: 'no-restricted-syntax',
    hint: 'infrastructure/persistence',
  },
  {
    fixture: 'packages/server/src/presentation/http/controllers/health.controller.ts',
    rule: 'no-restricted-syntax',
    hint: 'infrastructure/persistence',
  },
  {
    // The one ban that is *not* lifted inside the persistence layer. `$queryRawUnsafe` takes a
    // string, so the tenant predicate is whatever the caller concatenated — and the layer where
    // every other Prisma rule is relaxed is the layer where this fixture has to live.
    fixture: 'packages/server/src/infrastructure/persistence/raw-unsafe.repository.ts',
    rule: 'no-restricted-syntax',
    hint: 'bypass RLS review',
  },
  {
    // `rules/tenancy-rls.mdc` → «Как проверяется» promised this ban and `eslint.config.js` did not
    // have it. The array form opens no interactive transaction, so `withTenant` never wraps it and
    // `app.organization_id` is never set — inside `persistence/**`, where the other Prisma bans are
    // lifted, such a call passed the linter outright.
    fixture: 'packages/server/src/infrastructure/persistence/array-transaction.repository.ts',
    rule: 'no-restricted-syntax',
    hint: 'interactive transaction',
  },
];

/**
 * "A repository takes no `organizationId` and holds no client" used to rest on discipline alone.
 *
 * Both mistakes fail the same silent way: the policy filters against `app.organization_id`, so a
 * repository told a *different* organization is not refused — it is handed an empty result, which
 * reads like "there is no data" rather than like a defect (`tenant-scoped.repository.ts`).
 */
const REPOSITORY_TAKES_NO_TENANT: ForbiddenCase[] = [
  {
    fixture: 'packages/server/src/infrastructure/persistence/tenant-arg.repository.ts',
    rule: 'no-restricted-syntax',
    hint: 'second source of truth',
  },
  {
    fixture: 'packages/server/src/infrastructure/persistence/own-client.repository.ts',
    rule: 'no-restricted-imports',
    hint: 'composition root',
  },
];

const CLIENT_FSD: ForbiddenCase[] = [
  {
    fixture: 'packages/client/src/pages/board/page.tsx',
    rule: 'no-restricted-imports',
    hint: 'frontend-fsd',
  },
  {
    fixture: 'packages/client/src/pages/board/deep-import.component.tsx',
    rule: 'no-restricted-imports',
    hint: 'barrel',
  },
  {
    fixture: 'packages/client/src/units/task/ui/upward-import.component.tsx',
    rule: 'no-restricted-imports',
    hint: 'frontend-fsd',
  },
  {
    fixture: 'packages/client/src/units/auth/service/hooks/use-login.hook.ts',
    rule: 'no-restricted-globals',
    hint: 'shared/api',
  },
  // Both spellings of the storage ban, in both layers that hold the credential. The property form
  // exists because the identifier rule matches an unqualified name and nothing else, so
  // `globalThis.localStorage.setItem(...)` passed lint while breaking invariant 3.
  {
    fixture: 'packages/client/src/units/auth/lib/global-storage.util.ts',
    rule: 'no-restricted-properties',
    hint: 'persistent storage',
  },
  {
    fixture: 'packages/client/src/shared/api/global-storage.util.ts',
    rule: 'no-restricted-properties',
    hint: 'persistent storage',
  },
  {
    fixture: 'packages/client/src/units/task/api/tasks.api.ts',
    rule: 'no-restricted-syntax',
    hint: 'tanstack-query',
  },
  {
    // `shared` is the bottom layer: a utility there that knows about a domain unit inverts the
    // whole dependency direction, and it is the one direction no other fixture covered.
    fixture: 'packages/client/src/shared/lib/domain-import.util.ts',
    rule: 'no-restricted-imports',
    hint: 'shared',
  },
  {
    // Reaching into *another* unit's segments — the barrel of that unit is its only surface.
    fixture: 'packages/client/src/units/task/ui/foreign-unit.component.tsx',
    rule: 'bad-crm/no-foreign-unit-internals',
    hint: 'barrel',
  },
];

/**
 * `useEffect` is the escape hatch, and an escape hatch that costs nothing is used for everything.
 *
 * Both cases below are things the runtime never complains about: the first renders twice per
 * change and drifts out of sync the moment a render is skipped, the second is simply unexplained —
 * and an unexplained effect is how the first kind gets added next to it.
 */
const EFFECT_DISCIPLINE: ForbiddenCase[] = [
  {
    fixture: 'packages/client/src/units/task/service/hooks/use-derived-state.hook.ts',
    rule: 'bad-crm/no-effect-for-derived-state',
    hint: 'during render',
  },
  {
    fixture: 'packages/client/src/units/task/service/hooks/use-unjustified-effect.hook.ts',
    rule: 'bad-crm/no-effect-for-derived-state',
    hint: 'why',
  },
];

const NAMING: ForbiddenCase[] = [
  {
    fixture: 'packages/shared/src/default-export.util.ts',
    rule: 'import/no-default-export',
    hint: 'named export',
  },
  {
    fixture: 'packages/shared/src/noSuffix.ts',
    rule: 'bad-crm/require-role-suffix',
    hint: 'naming-and-structure',
  },
  {
    fixture: 'packages/client/src/units/task/ui/TaskCard.tsx',
    rule: 'unicorn/filename-case',
    hint: 'kebab',
  },
  {
    fixture: 'packages/client/src/units/task/ui/multi-comp.component.tsx',
    rule: 'react/no-multi-comp',
    hint: 'component',
  },
];

/**
 * The end-to-end suite waits for state, never for the clock.
 *
 * A fixed wait is the one instrument that turns a suite into a coin flip: too short and it fails on
 * a loaded runner, too long and every run pays for the worst case. Playwright retries its
 * assertions until the state arrives, so there is a correct alternative for every use.
 */
const E2E_HARNESS: ForbiddenCase[] = [
  {
    fixture: 'packages/e2e/tests/fixed-wait.spec.ts',
    rule: 'no-restricted-syntax',
    hint: 'waitForTimeout',
  },
];

const GENERAL: ForbiddenCase[] = [
  {
    fixture: 'packages/server/src/application/task/use-cases/console.use-case.ts',
    rule: 'no-console',
    hint: 'console',
  },
  {
    fixture: 'packages/client/src/units/task/ui/inline-style.component.tsx',
    rule: 'react/forbid-dom-props',
    hint: 'style',
  },
  {
    fixture: 'packages/server/src/application/task/use-cases/floating.use-case.ts',
    rule: '@typescript-eslint/no-floating-promises',
    hint: 'Promise',
  },
];

/**
 * Layer exceptions are exceptions, not amnesties.
 *
 * `shared/api` is allowed raw `fetch` and `shared/config` is allowed `import.meta.env` — but each
 * of those exemptions used to be spelled `'rule': 'off'`, which disables the *whole* rule for the
 * layer. In `shared/api` that also lifted the ban on persistent token storage, in the one
 * directory where a token store is most likely to be written; in `shared/config` it lifted every
 * other syntax ban. These fixtures prove the exception is now narrow.
 */
const NARROW_LAYER_EXCEPTIONS: ForbiddenCase[] = [
  {
    fixture: 'packages/client/src/shared/api/token-storage.util.ts',
    rule: 'no-restricted-globals',
    hint: 'persistent storage',
  },
  {
    fixture: 'packages/client/src/shared/config/remote-config.hook.ts',
    rule: 'no-restricted-syntax',
    hint: 'tanstack-query',
  },
];

/**
 * The repository suite reads through one recording door.
 *
 * `test/repo/workspace-layout.test.ts` audits the files the suite reads against the `inputs` of
 * `//#test:repo`, and it can only see reads that `readRepoFile`/`readJson` recorded. A spec calling
 * `readFileSync` itself would be a hole in that audit, and holes there are how `//#test:repo`
 * returned a cached PASS over a file it had never re-read — three times in one epic.
 */
const REPOSITORY_SUITE_READS: ForbiddenCase[] = [
  {
    fixture: 'test/raw-read.util.ts',
    rule: 'no-restricted-imports',
    hint: 'repo-fixture.util.ts',
  },
];

/** Configuration reaches the code through a schema, never through a raw environment read. */
const ENVIRONMENT_ACCESS: ForbiddenCase[] = [
  {
    fixture: 'packages/server/src/application/task/use-cases/env-read.use-case.ts',
    rule: 'no-restricted-properties',
    hint: 'load-env.util.ts',
  },
  {
    fixture: 'packages/client/src/units/task/service/hooks/use-api-url.hook.ts',
    rule: 'no-restricted-syntax',
    hint: 'shared/config',
  },
];

/** Files that follow every rule: the negative control alone cannot prove the config is wired up. */
const CLEAN_FIXTURES = [
  'packages/shared/src/error-code.enums.ts',
  'packages/server/src/domain/task/task.entity.ts',
  'packages/server/src/infrastructure/persistence/task.repository.ts',
  // The counterpart of `tenant-arg.repository.ts` and `array-transaction.repository.ts`: a
  // repository that derives its tenant, writes the column into the row and uses the interactive
  // form of `$transaction`. Without it the two bans above would read as correct while forbidding
  // the only shape a repository is allowed to have.
  'packages/server/src/infrastructure/persistence/scoped.repository.ts',
  'packages/client/src/units/task/service/hooks/use-task-list.hook.ts',
  'packages/client/src/shared/api/http.client.ts',
  // A unit reaching into its *own* segments: the counterpart of `foreign-unit.component.tsx`, and
  // the case that a plain `@units/*/*` ban gets wrong. Without it a unit cannot be written at all —
  // `ui` could not import the hook next door, and the ban would read as correct while making the
  // architecture it defends impossible.
  'packages/client/src/units/task/service/hooks/use-own-segment.hook.ts',
  // An effect that is a real side effect, carries its cleanup and says why it exists. The negative
  // controls above cannot prove the rule distinguishes the two.
  'packages/client/src/units/task/service/hooks/use-subscription.hook.ts',
  'test/recorded-read.util.ts',
];

/**
 * The first `lintFixture` call pays for building typescript-eslint's project service over the
 * whole fixture tree, which takes seconds — and more than five of them when the rest of the root
 * suite is running on the other workers. The default 5 s timeout therefore turned a cold cache
 * into a red build that goes green on a rerun. The budget is generous on purpose: it is a
 * one-time cost paid by whichever case happens to run first, not a per-case cost.
 */
const ESLINT_WARMUP_TIMEOUT_MS = 30_000;

const describeForbidden = (title: string, cases: ForbiddenCase[]): void => {
  describe(title, () => {
    it.each(cases)(
      '$fixture is rejected by $rule',
      async ({ fixture, rule, hint }) => {
        const { ruleIds, messages } = await lintFixture(fixture);

        expect(ruleIds).toContain(rule);
        expect(messages.join('\n')).toContain(hint);
      },
      ESLINT_WARMUP_TIMEOUT_MS,
    );
  });
};

describeForbidden('monorepo package boundaries', PACKAGE_BOUNDARIES);
describeForbidden('server hexagonal layers', HEXAGONAL_LAYERS);
describeForbidden('a repository derives its tenant, never receives it', REPOSITORY_TAKES_NO_TENANT);
describeForbidden('client FSD layers', CLIENT_FSD);
describeForbidden('effect discipline', EFFECT_DISCIPLINE);
describeForbidden('naming and file structure', NAMING);
describeForbidden('general hygiene', GENERAL);
describeForbidden('the end-to-end harness waits for state', E2E_HARNESS);
describeForbidden('environment access', ENVIRONMENT_ACCESS);
describeForbidden('layer exceptions stay narrow', NARROW_LAYER_EXCEPTIONS);
describeForbidden('repository suite reads', REPOSITORY_SUITE_READS);

/**
 * The fixtures live at invented paths. This block asks the opposite question: for a file that
 * actually ships, does ESLint still hand it the rule that is supposed to guard its layer?
 *
 * A `files` glob is silently satisfiable — it matched the fixture tree in every case above, and it
 * would keep matching it after the real directory it was written for had been renamed, split or
 * moved one level deeper. What follows names real files of `packages/client/src` and reads the
 * configuration ESLint resolves for them.
 */
describe('the shipped client tree is really covered, not only the fixtures', () => {
  /** `calculateConfigForFile` normalises severities to numbers; 2 is `error`, 0 is off or absent. */
  const severityOf = (rules: object, rule: string): unknown => {
    const entry = (rules as Record<string, unknown>)[rule];
    return Array.isArray(entry) ? entry[0] : (entry ?? 0);
  };

  const optionsOf = async (path: string, rule: string): Promise<string> => {
    const { rules } = await configForRepoFile(path);
    const entry = (rules as Record<string, unknown>)[rule];
    return JSON.stringify(entry ?? null);
  };

  it.each([
    ['packages/client/src/pages/home/page.tsx', 'react/no-multi-comp'],
    ['packages/client/src/pages/home/page.tsx', 'bad-crm/require-role-suffix'],
    ['packages/client/src/pages/home/page.tsx', 'bad-crm/no-effect-for-derived-state'],
    ['packages/client/src/widgets/app-status/app-status.widget.tsx', 'unicorn/filename-case'],
    [
      'packages/client/src/units/session/ui/session-status-badge.component.tsx',
      'bad-crm/no-foreign-unit-internals',
    ],
    ['packages/client/src/units/session/ui/session-status-badge.component.tsx', 'react/no-danger'],
    ['packages/client/src/shared/config/env.schema.ts', 'no-restricted-imports'],
  ])('%s has %s enabled', async (path, rule) => {
    const { rules } = await configForRepoFile(path);

    expect(severityOf(rules, rule), `${rule} is not applied to ${path}`).toBe(2);
  });

  it.each([
    ['packages/client/src/pages/home/page.tsx', 'no-restricted-syntax', 'tanstack-query'],
    [
      'packages/client/src/widgets/app-status/app-status.widget.tsx',
      'no-restricted-imports',
      'TanStack Query or axios',
    ],
    [
      'packages/client/src/shared/config/env.schema.ts',
      'no-restricted-imports',
      'bottom FSD layer',
    ],
  ])('%s carries the %s ban about %s', async (path, rule, hint) => {
    expect(await optionsOf(path, rule)).toContain(hint);
  });

  /**
   * The exemption has to be as real as the ban: a unit is where TanStack Query is supposed to live,
   * and a config that bans it everywhere would push fetching back up into the pages.
   */
  it('does not ban TanStack Query inside a unit, which is where it belongs', async () => {
    expect(
      await optionsOf(
        'packages/client/src/units/session/service/hooks/use-session-status.hook.ts',
        'no-restricted-imports',
      ),
    ).not.toContain('TanStack Query or axios');
  });
});

/**
 * The harness root files are linted at all.
 *
 * `playwright.config.ts` and `global-setup.ts` sit at the package root, outside the `src`/`tests`
 * glob the e2e block was originally written with — so both shipped with no rule ever applied to
 * them, including the ban on importing the application. Nothing noticed, because a file no
 * configuration matches is not an error to ESLint: it is simply not linted.
 */
describe('the end-to-end harness is covered outside src and tests', () => {
  const severity = (rules: object, rule: string): unknown => {
    const entry = (rules as Record<string, unknown>)[rule];
    return Array.isArray(entry) ? entry[0] : (entry ?? 0);
  };

  it.each([
    ['packages/e2e/playwright.config.ts', 'no-restricted-imports'],
    ['packages/e2e/playwright.config.ts', 'no-restricted-syntax'],
    ['packages/e2e/global-setup.ts', 'no-restricted-imports'],
    ['packages/e2e/global-setup.ts', '@typescript-eslint/no-floating-promises'],
  ])('%s has %s enabled', async (path, rule) => {
    const { rules } = await configForRepoFile(path);

    expect(severity(rules, rule), `${rule} is not applied to ${path}`).toBe(2);
  });
});

describe('positive control', () => {
  it.each(CLEAN_FIXTURES)(
    '%s lints clean',
    async (fixture) => {
      const { ruleIds, messages } = await lintFixture(fixture);

      expect({ ruleIds, messages }).toEqual({ ruleIds: [], messages: [] });
    },
    ESLINT_WARMUP_TIMEOUT_MS,
  );
});
