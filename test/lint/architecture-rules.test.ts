import { beforeAll, describe, expect, it } from 'vitest';

import {
  configForRepoFile,
  lintFixture,
  lintRepoFile,
  warmUpFixtureLint,
} from './eslint-fixture.util.js';

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
  // The landing is a leaf: it advertises the product and never imports it, or the whole point of
  // keeping it in the monorepo — that it cannot drift into being part of the application — is lost.
  {
    fixture: 'packages/landing/src/sections/demo/product-import.component.tsx',
    rule: 'no-restricted-imports',
    hint: 'landing',
  },
  // "Nothing you type here leaves the browser" is a claim the page makes to its reader, and this is
  // the rule that keeps it true. `globalThis.fetch` rather than a bare `fetch`, because that is the
  // spelling the package uses everywhere and the one a plain global ban does not see.
  {
    fixture: 'packages/landing/src/sections/demo/network.component.tsx',
    rule: 'no-restricted-properties',
    hint: 'EPIC-047',
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
  'packages/landing/src/shared/lib/clean.util.ts',
  'test/recorded-read.util.ts',
];

/**
 * The project service is built once, before any case runs — see `warmUpFixtureLint`.
 *
 * Before that, the cost landed on whichever case happened to be first, and a cold cache was
 * indistinguishable from a broken rule: red in CI, green on a rerun. Raising the per-case budget
 * (5 s → 30 s) moved the threshold, not the cost, and thirty seconds stopped being enough as well.
 * With the warm-up charged separately, a case that overruns *its* budget has genuinely got slow.
 */
const ESLINT_WARMUP_TIMEOUT_MS = 120_000;

/**
 * After the warm-up a single fixture lints in milliseconds, so this is slack rather than a cost.
 *
 * Kept at thirty seconds and not tightened: the previous attempt cut it to fifteen in the same change
 * that introduced the warm-up, and when the warm-up turned out to miss a resolver project the tighter
 * budget converted a flake into a deterministic failure. A generous per-case budget costs nothing
 * when the cases are fast and is the difference between a red build and a diagnosable one when they
 * are not.
 */
const CASE_TIMEOUT_MS = 30_000;

beforeAll(warmUpFixtureLint, ESLINT_WARMUP_TIMEOUT_MS);

const describeForbidden = (title: string, cases: ForbiddenCase[]): void => {
  describe(title, () => {
    it.each(cases)(
      '$fixture is rejected by $rule',
      async ({ fixture, rule, hint }) => {
        const { ruleIds, messages } = await lintFixture(fixture);

        expect(ruleIds).toContain(rule);
        expect(messages.join('\n')).toContain(hint);
      },
      CASE_TIMEOUT_MS,
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
 * The server-side counterpart of the block above, for the two Prisma bans of
 * `rules/tenancy-rls.mdc` rule 9: `PRISMA_OUTSIDE_PERSISTENCE` (`no-restricted-imports`, keyed on the
 * `@prisma/client` module specifier) and `PRISMA_CALL_OUTSIDE_PERSISTENCE` (`no-restricted-syntax`,
 * keyed on the `prisma`/`tx` identifiers). `HEXAGONAL_LAYERS` above proves both fire on invented
 * fixture paths; it cannot prove either is aimed at `packages/server/src`, and — per ADR-0027 — one of
 * the two is scheduled to stop being aimed at all. ADR-0027 ("Что проверено своими руками", п. 2)
 * documents that the generated Prisma client is planned to move out of `node_modules` (wave B), which
 * changes the specifier real code imports it by. The fixture at
 * `test/lint/fixtures/packages/server/src/domain/task/prisma.entity.ts` still imports the *old*
 * `@prisma/client` after that move and stays green for it — proving nothing about the shipped tree.
 * `PRISMA_CALL_OUTSIDE_PERSISTENCE` keys on the `prisma`/`tx` identifiers instead of a module
 * specifier, so the same rename does not touch it; the two cases below name what each ban actually
 * keys on, not just that a rule id is attached, so a rename that desyncs the config from real imports
 * fails exactly one of them instead of leaving both fixture-green.
 */
describe('the shipped server tree is really covered against Prisma leaking out of persistence', () => {
  /** `calculateConfigForFile` normalises severities to numbers; 2 is `error`, 0 is off or absent. */
  const severityOf = (rules: object, rule: string): unknown => {
    const entry = (rules as Record<string, unknown>)[rule];
    return Array.isArray(entry) ? entry[0] : (entry ?? 0);
  };

  /**
   * The banned *specifiers* only — never the surrounding message. A `no-restricted-imports` entry
   * carries `{ group, message }`, and the message is prose that happens to quote `` `@prisma/client` ``
   * for the reader; stringifying the whole entry and doing a substring check would pass on the
   * message alone, unchanged, even after `group` stopped naming anything real. That is exactly the
   * blind assertion `rules/testing.mdc` § "Тест, который не видели красным" warns about — caught here
   * by running this very check against the deliberately mis-specified `group` during the mutation
   * proof below, which stayed green under the naive JSON-substring version.
   */
  const importGroupsOf = async (path: string): Promise<string[]> => {
    const { rules } = await configForRepoFile(path);
    const entry = (rules as Record<string, unknown>)['no-restricted-imports'];
    if (!Array.isArray(entry)) return [];

    const options = entry[1] as { patterns?: unknown } | undefined;
    const patterns = Array.isArray(options?.patterns) ? options.patterns : [];

    return patterns.flatMap((pattern) => {
      if (pattern !== null && typeof pattern === 'object' && 'group' in pattern) {
        const group = (pattern as { group: unknown }).group;
        return Array.isArray(group) ? group.map(String) : [];
      }
      return [];
    });
  };

  /** `no-restricted-syntax` options are a severity followed by selector strings/objects. */
  const syntaxSelectorsOf = async (path: string): Promise<string[]> => {
    const { rules } = await configForRepoFile(path);
    const entry = (rules as Record<string, unknown>)['no-restricted-syntax'];
    if (!Array.isArray(entry)) return [];

    return entry.slice(1).flatMap((option) => {
      if (typeof option === 'string') return [option];
      if (option !== null && typeof option === 'object' && 'selector' in option) {
        return [String((option as { selector: unknown }).selector)];
      }
      return [];
    });
  };

  /** One real, shipping file per hexagonal layer the Prisma bans are supposed to reach. */
  const GUARDED_LAYER_FILES = [
    ['packages/server/src/domain/iam/access/employee-access.policy.ts', 'domain'],
    [
      'packages/server/src/application/organization/use-cases/bootstrap-organization.use-case.ts',
      'application',
    ],
    ['packages/server/src/presentation/http/controllers/auth.controller.ts', 'presentation'],
  ] as const;

  it.each(GUARDED_LAYER_FILES)(
    '%s (%s) bans @prisma/client via the specifier real Prisma imports actually use',
    async (path) => {
      const { rules } = await configForRepoFile(path);

      expect(
        severityOf(rules, 'no-restricted-imports'),
        'no-restricted-imports is not applied',
      ).toBe(2);
      // The assertion a path rename is meant to break: not "the rule is attached" but "the rule's own
      // `group` still names the specifier real code imports Prisma by" — see
      // `packages/server/src/infrastructure/persistence/prisma/prisma.client.ts`, which does
      // `import { type Prisma, PrismaClient } from '@prisma/client'`.
      const groups = await importGroupsOf(path);
      expect(groups, `no banned group names '@prisma/client' in: ${groups.join(' | ')}`).toContain(
        '@prisma/client',
      );
    },
  );

  it.each(GUARDED_LAYER_FILES)(
    '%s (%s) bans direct prisma.*/tx.* access via the identifier it keys on',
    async (path) => {
      const { rules } = await configForRepoFile(path);

      expect(severityOf(rules, 'no-restricted-syntax'), 'no-restricted-syntax is not applied').toBe(
        2,
      );

      const selectors = await syntaxSelectorsOf(path);
      expect(
        selectors.some((selector) => selector.includes("object.name='prisma'")),
        `no selector for MemberExpression[object.name='prisma'] in: ${selectors.join(' | ')}`,
      ).toBe(true);
      expect(
        selectors.some((selector) => selector.includes("object.name='tx'")),
        `no selector for MemberExpression[object.name='tx'] in: ${selectors.join(' | ')}`,
      ).toBe(true);
    },
  );

  /**
   * The exemption has to be as real as the ban: `infrastructure/persistence/**` is the one layer
   * allowed to hold Prisma, and a config that banned it there too would make the repository layer
   * impossible to write — `prisma.client.ts` is not a hypothetical, it is the file that constructs
   * the `PrismaClient` the rest of the persistence layer runs on.
   */
  it('does not ban @prisma/client or direct prisma.*/tx.* access inside infrastructure/persistence, which is where it belongs', async () => {
    const path = 'packages/server/src/infrastructure/persistence/prisma/prisma.client.ts';

    expect(await importGroupsOf(path)).not.toContain('@prisma/client');

    const selectors = await syntaxSelectorsOf(path);
    expect(selectors.some((selector) => selector.includes("object.name='prisma'"))).toBe(false);
    expect(selectors.some((selector) => selector.includes("object.name='tx'"))).toBe(false);
  });
});

/**
 * The rest of the server hexagonal-layer bans of `rules/hexagonal-backend.mdc` and
 * `rules/tenancy-rls.mdc`: `SERVER_STAYS_SERVER`, `DOMAIN_HAS_NO_IO`, `DOMAIN_IS_INNERMOST`,
 * `APPLICATION_KNOWS_NO_ADAPTERS`, `PRESENTATION_IS_THIN`, `DB_CLIENT_OUTSIDE_COMPOSITION_ROOT`,
 * `UNSAFE_RAW_SQL`, `ARRAY_TRANSACTION` and `REPOSITORY_TAKES_NO_TENANT`. `HEXAGONAL_LAYERS` and
 * `REPOSITORY_TAKES_NO_TENANT` (the `ForbiddenCase[]` above) prove each of these fires on an invented
 * fixture path under `test/lint/fixtures/**`; that proves the rule *can* fire, not that it is aimed at
 * `packages/server/src` — the gap the block above closed for the two Prisma-specific bans, and the same
 * gap for the rest of the layer bans until now.
 *
 * As in that block, every assertion reads `group`/`selector` structure, never the serialized rule entry
 * or a substring of its `message`: the message is prose written to quote the thing it bans for a human
 * reader, so a substring check against it stays green even after the `group`/`selector` that actually
 * drives enforcement has been narrowed to miss the real specifier (`rules/testing.mdc` §
 * "Тест, который не видели красным").
 */
describe('the shipped server tree is really covered by the hexagonal-layer bans', () => {
  /** `calculateConfigForFile` normalises severities to numbers; 2 is `error`, 0 is off or absent. */
  const severityOf = (rules, rule) => {
    const entry = rules[rule];
    return Array.isArray(entry) ? entry[0] : (entry ?? 0);
  };

  /** The banned import-group specifiers only — see the docstring above for why not the message. */
  const importGroupsOf = async (path) => {
    const { rules } = await configForRepoFile(path);
    const entry = rules['no-restricted-imports'];
    if (!Array.isArray(entry)) return [];

    const options = entry[1];
    const patterns = Array.isArray(options?.patterns) ? options.patterns : [];

    return patterns.flatMap((pattern) => {
      if (pattern !== null && typeof pattern === 'object' && 'group' in pattern) {
        const group = pattern.group;
        return Array.isArray(group) ? group.map(String) : [];
      }
      return [];
    });
  };

  /** `no-restricted-syntax` options are a severity followed by selector strings/objects. */
  const syntaxSelectorsOf = async (path) => {
    const { rules } = await configForRepoFile(path);
    const entry = rules['no-restricted-syntax'];
    if (!Array.isArray(entry)) return [];

    return entry.slice(1).flatMap((option) => {
      if (typeof option === 'string') return [option];
      if (option !== null && typeof option === 'object' && 'selector' in option) {
        return [String(option.selector)];
      }
      return [];
    });
  };

  /**
   * `SERVER_STAYS_SERVER` is never lifted: every layer-specific block below re-declares
   * `no-restricted-imports` from scratch (flat config replaces the whole rule entry per matching
   * file, it does not merge pattern arrays across blocks), and every one of those redeclarations
   * still lists it — checked here on one real file per redeclaration.
   */
  it.each([
    ['packages/server/src/domain/iam/access/employee-access.policy.ts', 'domain'],
    [
      'packages/server/src/application/organization/use-cases/bootstrap-organization.use-case.ts',
      'application',
    ],
    ['packages/server/src/presentation/http/controllers/auth.controller.ts', 'presentation'],
    ['packages/server/src/infrastructure/persistence/prisma/user.repository.ts', 'persistence'],
    ['packages/server/src/infrastructure/bootstrap/container.factory.ts', 'composition root'],
  ])('SERVER_STAYS_SERVER: %s (%s) still bans @bad-crm/client and @bad-crm/e2e', async (path) => {
    const { rules } = await configForRepoFile(path);
    expect(severityOf(rules, 'no-restricted-imports'), 'no-restricted-imports is not applied').toBe(
      2,
    );

    const groups = await importGroupsOf(path);
    expect(groups, `no group names '@bad-crm/client' in: ${groups.join(' | ')}`).toContain(
      '@bad-crm/client',
    );
    expect(groups, `no group names '@bad-crm/e2e' in: ${groups.join(' | ')}`).toContain(
      '@bad-crm/e2e',
    );
  });

  describe('DOMAIN_HAS_NO_IO bans I/O modules inside domain, and only inside domain', () => {
    const domainFile = 'packages/server/src/domain/iam/access/employee-access.policy.ts';

    it('bans express, ioredis and the node: prefix on a real domain policy', async () => {
      const groups = await importGroupsOf(domainFile);
      expect(groups).toContain('express');
      expect(groups).toContain('ioredis');
      expect(groups).toContain('node:*');
    });

    /**
     * The counterpart: `infrastructure/redis/redis.client.ts` is the module that actually opens the
     * `ioredis` connection the rest of the process shares. If `DOMAIN_HAS_NO_IO` reached this file too,
     * the file the ban's own I/O it is meant to fence off could not be written.
     */
    it('does not reach the infrastructure file that legitimately imports ioredis', async () => {
      const groups = await importGroupsOf(
        'packages/server/src/infrastructure/redis/redis.client.ts',
      );
      expect(groups).not.toContain('ioredis');
    });
  });

  it('DOMAIN_IS_INNERMOST bans importing outward from a real domain policy', async () => {
    const groups = await importGroupsOf(
      'packages/server/src/domain/iam/access/employee-access.policy.ts',
    );
    expect(groups).toContain('@/application');
    expect(groups).toContain('@/infrastructure');
    expect(groups).toContain('@/presentation');
  });

  it('APPLICATION_KNOWS_NO_ADAPTERS bans adapters on a real use-case', async () => {
    const groups = await importGroupsOf(
      'packages/server/src/application/organization/use-cases/bootstrap-organization.use-case.ts',
    );
    expect(groups).toContain('@/infrastructure');
    expect(groups).toContain('@/presentation');
  });

  it('PRESENTATION_IS_THIN bans adapters on a real controller', async () => {
    const groups = await importGroupsOf(
      'packages/server/src/presentation/http/controllers/auth.controller.ts',
    );
    expect(groups).toContain('@/infrastructure');
  });

  describe('DB_CLIENT_OUTSIDE_COMPOSITION_ROOT bans the client-factory specifier outside the composition root', () => {
    it.each([
      ['packages/server/src/app-info.constant.ts', 'a generic server module'],
      ['packages/server/src/infrastructure/persistence/prisma/user.repository.ts', 'a repository'],
    ])('%s (%s) still bans the client-factory specifier', async (path) => {
      const groups = await importGroupsOf(path);
      expect(groups, `no group names '**/prisma.client.js' in: ${groups.join(' | ')}`).toContain(
        '**/prisma.client.js',
      );
    });

    /**
     * The exemption has to be as real as the ban: `database.factory.ts` is the module that
     * constructs the `PrismaClient`, and `container.factory.ts` (`infrastructure/bootstrap/**`) is
     * the composition root that calls `connectDatabase` — both would be impossible to write under
     * the general ban this block is proving is otherwise in force.
     */
    it.each([
      [
        'packages/server/src/infrastructure/persistence/prisma/database.factory.ts',
        'the module that owns the client',
      ],
      ['packages/server/src/infrastructure/bootstrap/container.factory.ts', 'the composition root'],
    ])('%s (%s) does not ban the client-factory specifier', async (path) => {
      const groups = await importGroupsOf(path);
      expect(groups).not.toContain('**/prisma.client.js');
    });
  });

  /**
   * Unlike `PRISMA_OUTSIDE_PERSISTENCE`/`PRISMA_CALL_OUTSIDE_PERSISTENCE`, neither of these two is
   * lifted inside `infrastructure/persistence/**` — checked here on a persistence file itself, not
   * only on a generic module, since that is exactly the layer the two Prisma bans above *do* relax.
   */
  describe('UNSAFE_RAW_SQL and ARRAY_TRANSACTION are not lifted anywhere, including persistence', () => {
    it.each([
      ['packages/server/src/app-info.constant.ts', 'a generic server module'],
      [
        'packages/server/src/infrastructure/persistence/prisma/prisma.client.ts',
        'persistence itself',
      ],
      ['packages/server/src/infrastructure/persistence/prisma/user.repository.ts', 'a repository'],
    ])('%s (%s) carries both raw-SQL bans', async (path) => {
      const { rules } = await configForRepoFile(path);
      expect(severityOf(rules, 'no-restricted-syntax'), 'no-restricted-syntax is not applied').toBe(
        2,
      );

      const selectors = await syntaxSelectorsOf(path);
      expect(
        selectors.some((selector) => selector.includes('queryRawUnsafe')),
        `no selector for $queryRawUnsafe/$executeRawUnsafe in: ${selectors.join(' | ')}`,
      ).toBe(true);
      expect(
        selectors.some(
          (selector) =>
            selector.includes("callee.property.name='$transaction'") &&
            selector.includes('ArrayExpression'),
        ),
        `no selector for the array form of $transaction in: ${selectors.join(' | ')}`,
      ).toBe(true);
    });
  });

  describe('REPOSITORY_TAKES_NO_TENANT bans an organizationId parameter or field, and only on a repository', () => {
    it.each([
      ['packages/server/src/infrastructure/persistence/prisma/user.repository.ts'],
      ['packages/server/src/infrastructure/persistence/prisma/tenant-scoped.repository.ts'],
    ])('%s carries the organizationId ban', async (path) => {
      const selectors = await syntaxSelectorsOf(path);
      expect(
        selectors.some((selector) =>
          selector.includes("PropertyDefinition > Identifier.key[name='organizationId']"),
        ),
        `no field-form selector for organizationId in: ${selectors.join(' | ')}`,
      ).toBe(true);
      expect(
        selectors.some((selector) =>
          selector.includes("TSParameterProperty > Identifier[name='organizationId']"),
        ),
        `no constructor-param-form selector for organizationId in: ${selectors.join(' | ')}`,
      ).toBe(true);
    });

    /**
     * The counterpart of `scoped.repository.ts` in the fixture tree: a real persistence file that is
     * not itself a repository. Without this, the assertions above could be reading a config that bans
     * `organizationId` across the whole persistence layer — which would make `TenantScopedRepository`
     * itself, and every field the persistence layer stores the column in, impossible to type — rather
     * than one scoped to `*.repository.ts` the way `SERVER_REPOSITORIES` declares it.
     */
    it('does not reach a persistence file that is not a repository', async () => {
      const selectors = await syntaxSelectorsOf(
        'packages/server/src/infrastructure/persistence/prisma/prisma.client.ts',
      );
      expect(selectors.some((selector) => selector.includes("name='organizationId'"))).toBe(false);
    });
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
    ['packages/e2e/global-teardown.ts', 'no-restricted-imports'],
    ['packages/e2e/global-teardown.ts', '@typescript-eslint/no-floating-promises'],
  ])('%s has %s enabled', async (path, rule) => {
    const { rules } = await configForRepoFile(path);

    expect(severity(rules, rule), `${rule} is not applied to ${path}`).toBe(2);
  });

  /**
   * `global-teardown.ts` is a fixed name, exactly as `global-setup.ts` is.
   *
   * Playwright resolves `globalTeardown` by path and the name is its vocabulary; renaming it to
   * `something.util.ts` to satisfy the suffix dictionary would hide the file from everyone who
   * knows the tool. Asserted here rather than left to the plugin's own list, because the pair is
   * the point: an exemption granted to the setup and withheld from the teardown is an oversight,
   * not a decision.
   */
  it('exempts both Playwright lifecycle files from the role-suffix dictionary', async () => {
    const offences = await Promise.all(
      ['packages/e2e/global-setup.ts', 'packages/e2e/global-teardown.ts'].map(async (path) => ({
        path,
        ruleIds: (await lintRepoFile(path)).ruleIds.filter(
          (id) => id === 'bad-crm/require-role-suffix',
        ),
      })),
    );

    expect(offences).toEqual([
      { path: 'packages/e2e/global-setup.ts', ruleIds: [] },
      { path: 'packages/e2e/global-teardown.ts', ruleIds: [] },
    ]);
  });
});

describe('positive control', () => {
  it.each(CLEAN_FIXTURES)(
    '%s lints clean',
    async (fixture) => {
      const { ruleIds, messages } = await lintFixture(fixture);

      expect({ ruleIds, messages }).toEqual({ ruleIds: [], messages: [] });
    },
    CASE_TIMEOUT_MS,
  );
});
