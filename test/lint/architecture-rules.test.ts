import { describe, expect, it } from 'vitest';

import { lintFixture } from './eslint-fixture.util.js';

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
  {
    fixture: 'packages/client/src/units/task/api/tasks.api.ts',
    rule: 'no-restricted-syntax',
    hint: 'tanstack-query',
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
  'packages/client/src/units/task/service/hooks/use-task-list.hook.ts',
  'packages/client/src/shared/api/http.client.ts',
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
describeForbidden('client FSD layers', CLIENT_FSD);
describeForbidden('naming and file structure', NAMING);
describeForbidden('general hygiene', GENERAL);
describeForbidden('environment access', ENVIRONMENT_ACCESS);
describeForbidden('layer exceptions stay narrow', NARROW_LAYER_EXCEPTIONS);
describeForbidden('repository suite reads', REPOSITORY_SUITE_READS);

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
