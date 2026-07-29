// Bad CRM — ESLint 9 flat config, single source for all four packages.
//
// Why one root config instead of per-package files: ESLint resolves `files` globs relative to the
// directory of the config file it loaded, not to the working directory. `turbo run lint` runs
// `eslint .` with cwd = the package, ESLint walks up to this file, and the `packages/<pkg>/src/**`
// globs below still match. One file, one place to read the architecture contract.
//
// The architectural bans are the point of this config, not a formality. Each message names the
// rule file it enforces (`rules/*.mdc`) so a failing build tells you where the contract lives.
// `test/lint/architecture-rules.test.ts` lints deliberately broken fixtures against this very file
// and fails if any ban is dropped.
//
// Type-aware rules below run on the same TypeScript the packages compile with: the workspace is on
// a single version (ADR-0022), so the linter and `tsc` can never disagree about a type.
import { join } from 'node:path';

import js from '@eslint/js';
import vitest from '@vitest/eslint-plugin';
import prettier from 'eslint-config-prettier';
import importPlugin from 'eslint-plugin-import';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import unicorn from 'eslint-plugin-unicorn';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import { badCrmPlugin } from './eslint/bad-crm.plugin.js';

// ─── globs ────────────────────────────────────────────────────────────────────────────────────
const SHARED = 'packages/shared/src/**/*.ts';
const SERVER = 'packages/server/src/**/*.ts';
const SERVER_DOMAIN = 'packages/server/src/domain/**/*.ts';
const SERVER_APPLICATION = 'packages/server/src/application/**/*.ts';
const SERVER_PRESENTATION = 'packages/server/src/presentation/**/*.ts';
const SERVER_PERSISTENCE = 'packages/server/src/infrastructure/persistence/**/*.ts';
/**
 * The composition root of the server: the only place a database client is constructed.
 *
 * `main.ts` is three lines; the wiring itself lives here, which is why the exemption is written
 * against this directory rather than against a single file (`container.factory.ts` documents the
 * same split).
 */
const SERVER_COMPOSITION_ROOT = 'packages/server/src/infrastructure/bootstrap/**/*.ts';
/** The module that owns `connectDatabase`, and therefore the one that may open the pool. */
const SERVER_DB_CLIENT_OWNER =
  'packages/server/src/infrastructure/persistence/prisma/database.factory.ts';
/** Repositories, wherever they live: the bans below are about the shape of the class, not the layer. */
const SERVER_REPOSITORIES = 'packages/server/src/**/*.repository.ts';
const SERVER_LOGGING = 'packages/server/src/infrastructure/logging/**/*.ts';
const CLIENT = 'packages/client/src/**/*.{ts,tsx}';
/**
 * Layers that consume the data layer without owning it. `app/**` used to be listed here and is not
 * any more: `rules/frontend-fsd.mdc` → «Исключения» grants the composition root the right to import
 * anything, because that is where the provider tree is assembled — and `app/providers.tsx` cannot
 * mount `QueryClientProvider` without importing it. What stays banned there is *calling* a query
 * hook (`CLIENT_COMPOSITION_ROOT` below), which is the part of the rule that is about fetching.
 */
const CLIENT_CONSUMERS = [
  'packages/client/src/pages/**/*.{ts,tsx}',
  'packages/client/src/widgets/**/*.{ts,tsx}',
];
const CLIENT_COMPOSITION_ROOT = 'packages/client/src/app/**/*.{ts,tsx}';
/**
 * File-based routes: the file *name* is the URL, so the naming conventions cannot apply to them.
 * `__root.tsx`, `_authenticated.tsx` and `dashboard.tsx` are dictated by
 * `@tanstack/router-plugin`, which reads this directory to generate the route tree.
 */
const CLIENT_ROUTE_FILES = 'packages/client/src/app/routes/**/*.tsx';
const CLIENT_UNITS = 'packages/client/src/units/**/*.{ts,tsx}';
const CLIENT_UNIT_API = 'packages/client/src/units/*/api/**/*.ts';
const CLIENT_SHARED = 'packages/client/src/shared/**/*.{ts,tsx}';
const CLIENT_SHARED_API = 'packages/client/src/shared/api/**/*.ts';
/** The only client layer allowed to touch `import.meta.env`; everything else imports the result. */
const CLIENT_ENV_READERS = 'packages/client/src/shared/config/**/*.ts';
const CLIENT_AUTH_UNIT = 'packages/client/src/units/auth/**/*.{ts,tsx}';
const CLIENT_UI = [
  'packages/client/src/app/**/*.tsx',
  'packages/client/src/pages/**/*.tsx',
  'packages/client/src/widgets/**/*.tsx',
  'packages/client/src/units/*/ui/**/*.tsx',
  // Added with the design system (STORY-004-03): `shared/ui` is where the accessible primitives
  // live, and it was the one directory full of components that no a11y rule was looking at.
  'packages/client/src/shared/ui/**/*.tsx',
];
const E2E = 'packages/e2e/{src,tests}/**/*.ts';
const TESTS = [
  'packages/*/test/**/*.ts',
  'packages/**/*.{test,spec}.{ts,tsx}',
  'test/**/*.test.ts',
];
// `packages/*/scripts/**` is tooling that happens to live inside a package: `pnpm check:rls` is an
// operator command run against a host, not code that ships in `dist`. Without this entry it matched
// no configuration at all — `eslint .` in the package would report it as ignored, and
// `--max-warnings 0` would fail the lint of the package that owns it.
const REPO_TOOLING = [
  '*.js',
  '*.ts',
  'test/**/*.ts',
  'scripts/**/*.ts',
  'packages/*/scripts/**/*.ts',
  'eslint/**/*.js',
];
/** The repository-contract suite, both its specs and the fixtures they share. */
const REPO_SUITE = ['test/**/*.ts'];
/** The one module in the suite allowed to touch the filesystem — it is the recording door. */
const REPO_SUITE_FS_DOOR = ['test/repo/repo-fixture.util.ts'];

// ─── monorepo package boundaries (CLAUDE.md → «Раскладка пакетов и нейминг») ──────────────────
const workspace = (...names) => names.flatMap((name) => [`@bad-crm/${name}`, `@bad-crm/${name}/*`]);

const SHARED_IS_LEAF = {
  group: workspace('server', 'client', 'e2e'),
  message:
    '`packages/shared` sits at the bottom of the dependency graph: it is isomorphic code and must not import server, client or e2e sources. Dependency direction is fixed in CLAUDE.md → «Раскладка пакетов и нейминг».',
};
const SERVER_STAYS_SERVER = {
  group: workspace('client', 'e2e'),
  message:
    '`packages/server` may only depend on `@bad-crm/shared`. Importing client or e2e code from the server breaks the one-way package graph (CLAUDE.md → «Раскладка пакетов и нейминг»).',
};
const CLIENT_STAYS_CLIENT = {
  group: workspace('server', 'e2e'),
  message:
    '`packages/client` may only depend on `@bad-crm/shared`. Server internals reach the client through the OpenAPI contract, never through an import (CLAUDE.md → «Раскладка пакетов и нейминг»).',
};
const E2E_IS_BLACK_BOX = {
  group: workspace('shared', 'server', 'client'),
  message:
    '`packages/e2e` drives the running stack over HTTP and the UI; importing application sources would let a test pass against code that is not deployed (CLAUDE.md → «Раскладка пакетов и нейминг»).',
};

const READS_GO_THROUGH_THE_REGISTRY = {
  group: ['fs', 'fs/*', 'node:fs', 'node:fs/*'],
  message:
    'The repository suite reads through `readRepoFile`/`readJson` from `test/repo/repo-fixture.util.ts`, which records the path so that `test/repo/workspace-layout.test.ts` can prove the `inputs` of `//#test:repo` still hash everything the suite reads. A direct `readFileSync` is invisible to that audit and brings back the cached PASS over an unread file.',
};

const NO_PARENT_RELATIVE = {
  group: ['../*', '../**'],
  message:
    'Relative parent imports are forbidden — use the `@/*` alias on the server and the `@app|@pages|@widgets|@units|@shared` aliases on the client. See rules/hexagonal-backend.mdc and rules/frontend-fsd.mdc.',
};

// ─── server: hexagonal layers (rules/hexagonal-backend.mdc, rules/tenancy-rls.mdc) ────────────
const PRISMA_OUTSIDE_PERSISTENCE = {
  group: ['@prisma/client', '@prisma/client/*'],
  message:
    'Prisma is an infrastructure detail: `@prisma/client` may only be imported inside `src/infrastructure/persistence/**`. Everything else talks to a `*-repository.port.ts` (rules/hexagonal-backend.mdc, rules/tenancy-rls.mdc).',
};
const DOMAIN_HAS_NO_IO = {
  group: [
    'node:*',
    'node:*/*',
    'express',
    'ioredis',
    'socket.io',
    'socket.io/*',
    'bullmq',
    'meilisearch',
    '@aws-sdk/*',
    'nodemailer',
  ],
  message:
    '`domain` knows nothing about I/O: no Node built-ins, HTTP, Redis, queues or storage. Time comes from `ClockPort`, ids from `IdGeneratorPort` (rules/hexagonal-backend.mdc, rule 2).',
};
const DOMAIN_IS_INNERMOST = {
  group: [
    '@/application',
    '@/application/*',
    '@/infrastructure',
    '@/infrastructure/*',
    '@/presentation',
    '@/presentation/*',
  ],
  message:
    'Dependencies point inwards only: `domain` must not import `application`, `infrastructure` or `presentation` (rules/hexagonal-backend.mdc, rule 1).',
};
const APPLICATION_KNOWS_NO_ADAPTERS = {
  group: ['@/infrastructure', '@/infrastructure/*', '@/presentation', '@/presentation/*'],
  message:
    '`application` depends on `domain` and on its own ports only. Concrete adapters are wired in `main.ts`, the single composition root (rules/hexagonal-backend.mdc, rules 3 and 12).',
};
const PRESENTATION_IS_THIN = {
  group: ['@/infrastructure', '@/infrastructure/*'],
  message:
    '`presentation/http` is thin transport: validate, call one use-case, serialize. Adapters are wired in `main.ts`, not imported by controllers (rules/hexagonal-backend.mdc, rule 5).',
};

const PRISMA_CALL_OUTSIDE_PERSISTENCE = [
  {
    selector: "MemberExpression[object.name='prisma']",
    message:
      'Direct `prisma.*` access is allowed only inside `src/infrastructure/persistence/**` — everywhere else the tenant context of `withTenant(...)` is not guaranteed (invariant 1 in CLAUDE.md, rules/tenancy-rls.mdc).',
  },
  {
    selector: "MemberExpression[object.name='tx']",
    message:
      'Direct `tx.*` access is allowed only inside `src/infrastructure/persistence/**` — a transaction handle outside the persistence layer escapes the tenant context (invariant 1 in CLAUDE.md, rules/tenancy-rls.mdc).',
  },
];
const UNSAFE_RAW_SQL = {
  selector:
    'CallExpression[callee.property.name=/^\\$(queryRawUnsafe|executeRawUnsafe)$/], MemberExpression[property.name=/^\\$(queryRawUnsafe|executeRawUnsafe)$/]',
  message:
    '`$queryRawUnsafe` / `$executeRawUnsafe` interpolate strings into SQL and bypass RLS review. Use the tagged-template variants inside `infrastructure/persistence/**` (rules/tenancy-rls.mdc).',
};
/**
 * The array form of `$transaction`, which `rules/tenancy-rls.mdc` rule 10 has always banned and
 * which nothing enforced until now.
 *
 * It is not an interactive transaction: Prisma sends the batch itself, so there is no callback for
 * `withTenant` to run `set_config('app.organization_id', …)` in. Every statement of the batch is
 * then judged by the tenant policy against a context that was never set — and inside
 * `infrastructure/persistence/**`, where the other Prisma bans are lifted, such a call used to pass
 * the linter outright.
 */
const ARRAY_TRANSACTION = {
  selector:
    "CallExpression[callee.property.name='$transaction'][arguments.0.type='ArrayExpression']",
  message:
    'The array form of `$transaction([...])` opens no interactive transaction, so `withTenant` cannot set `app.organization_id` around it and the tenant policies are evaluated with no context. Use the interactive form through `withTenant` (invariant 1 in CLAUDE.md, rules/tenancy-rls.mdc rule 10).',
};

/**
 * A repository derives its tenant; it never receives one, and it never holds a client.
 *
 * Both mistakes are invisible at runtime. The policy filters rows against `app.organization_id`, so
 * a repository handed a *different* organization is not refused — it gets an empty result, which
 * reads like "there is no data" (`tenant-scoped.repository.ts`, header). A repository holding its
 * own client is worse: the handle was never inside a tenant scope, so `guardedClient` never sees
 * the call.
 *
 * The selectors name parameters and class fields only. `this.organizationId()` is a call, the
 * `organizationId` of a Prisma `data` payload is the column being written, and a ban keyed on the
 * identifier alone would forbid the one shape a repository is allowed to have —
 * `scoped.repository.ts` in the fixture tree is the control that holds that distinction.
 */
const REPOSITORY_TAKES_NO_TENANT = {
  selector: [
    ":matches(FunctionDeclaration, FunctionExpression, ArrowFunctionExpression) > Identifier[name='organizationId']",
    ":matches(FunctionDeclaration, FunctionExpression, ArrowFunctionExpression) > AssignmentPattern > Identifier[name='organizationId']",
    ":matches(FunctionDeclaration, FunctionExpression, ArrowFunctionExpression) > TSParameterProperty > Identifier[name='organizationId']",
    ":matches(FunctionDeclaration, FunctionExpression, ArrowFunctionExpression) > ObjectPattern > Property > Identifier[name='organizationId']",
    "PropertyDefinition > Identifier.key[name='organizationId']",
  ].join(', '),
  message:
    'A repository must not take or store an `organizationId`: that is a second source of truth for the tenant, and when it disagrees with the scope the query is not rejected but silently filtered to nothing. Read it from the scope `withTenant` opened, through `TenantScopedRepository` (invariant 1 in CLAUDE.md, rules/tenancy-rls.mdc rule 9).',
};

const DB_CLIENT_OUTSIDE_COMPOSITION_ROOT = {
  group: [
    '@/infrastructure/persistence/prisma/prisma.client.js',
    '@/infrastructure/persistence/prisma/database.factory.js',
    './prisma.client.js',
    './database.factory.js',
    '**/prisma.client.js',
    '**/database.factory.js',
  ],
  message:
    'A database client is constructed once, in the composition root (`infrastructure/bootstrap/**`), and reaches a repository as the transaction of the scope `withTenant` opened. A client created anywhere else runs outside that scope, so `app.organization_id` is never set and `guardedClient` never sees the call (invariant 1 in CLAUDE.md, rules/tenancy-rls.mdc rules 9 and 11).',
};

// ─── client: FSD layers (rules/frontend-fsd.mdc, rules/tanstack-query.mdc) ────────────────────
const UNIT_DEEP_IMPORT = {
  group: ['@units/*/*', '@units/*/**', '@shared/*/*/**', '@app/*/*/**', '@widgets/*/*/**'],
  message:
    'A unit exposes exactly one public surface — its namespace barrel. Import `{ TaskService } from "@units/task"`, never a path inside the unit (rules/frontend-fsd.mdc, rule 3).',
};
/**
 * The same ban, minus the part a unit cannot live under.
 *
 * Inside `units/**` the pattern above forbids a unit from importing *its own* segments — `ui` may
 * not reach the hook next door — while `../` is banned everywhere, which leaves a unit with no way
 * to be written at all. Measured on the first real unit (STORY-004-02), not deduced. The unit-to-unit
 * half of the ban is kept by `bad-crm/no-foreign-unit-internals`, which compares the specifier with
 * the importing file's own unit and so can tell the two cases apart.
 */
const DEEP_IMPORT_INSIDE_UNITS = {
  group: ['@shared/*/*/**', '@app/*/*/**', '@widgets/*/*/**'],
  message:
    'Import a layer through its barrel (`@shared`, `@widgets/<widget>`), not through a path inside a segment (rules/frontend-fsd.mdc, rule 3).',
};
const NO_DATA_LAYER_IN_CONSUMERS = {
  group: ['@tanstack/react-query', '@tanstack/react-query/*', 'axios', 'axios/*'],
  message:
    'Pages, widgets and app know nothing about network or cache: call a unit service hook (`XxxService.useY()`) instead of TanStack Query or axios (rules/frontend-fsd.mdc, rule 5).',
};
const UNITS_DO_NOT_LOOK_UP = {
  group: ['@app', '@app/*', '@pages', '@pages/*', '@widgets', '@widgets/*'],
  message:
    'FSD dependencies point downwards only (app → pages → widgets → units → shared): a unit must not import a page, widget or app module (rules/frontend-fsd.mdc, rule 1).',
};
const SHARED_IS_DOMAIN_FREE = {
  group: ['@app', '@app/*', '@pages', '@pages/*', '@widgets', '@widgets/*', '@units/*'],
  message:
    '`shared` is the bottom FSD layer and carries no domain knowledge: it must not import units, widgets, pages or app (rules/frontend-fsd.mdc, rules 1 and 8).',
};
/**
 * The toaster is the single notification surface (`rules/errors-and-toasts.mdc` §1): one wrapper,
 * one `<Notifications />`, one dedupe policy. A component calling the vendor directly bypasses the
 * stable-id rule and produces the stack of identical toasts the wrapper exists to prevent.
 * `app/providers.tsx` mounts the container itself, which is why it is allowed too.
 */
const NOTIFICATIONS_VIA_TOASTER = {
  group: ['@mantine/notifications', '@mantine/notifications/*'],
  message:
    'Notifications go through `SharedUi.notify` (`shared/ui/toaster`), never through the vendor: the wrapper owns the stable id, the dedupe and the ARIA role (rules/errors-and-toasts.mdc §1, §6).',
};
const AXIOS_OUTSIDE_SHARED_API = {
  group: ['axios', 'axios/*'],
  message:
    'HTTP transport lives in `shared/api` only. Everything else goes through the generated client (rules/api-contract.mdc, rules/frontend-fsd.mdc).',
};
const QUERY_HOOK_CALLS = [
  {
    selector: 'CallExpression[callee.name=/^use(Query|Mutation|InfiniteQuery|SuspenseQuery)$/]',
    message:
      'TanStack Query hooks belong to `units/<unit>/service/{queries,mutations,hooks}`. Here they either skip the unit barrel or put fetching in a layer that must stay presentational (rules/frontend-fsd.mdc rule 5, rules/tanstack-query.mdc rule 11).',
  },
];
const NO_FETCH_GLOBALS = [
  {
    name: 'fetch',
    message:
      'Raw `fetch` is allowed in `packages/client/src/shared/api/**` only — everything else uses the typed client so auth, error mapping and cancellation stay in one place (rules/api-contract.mdc, rules/frontend-fsd.mdc).',
  },
  {
    name: 'XMLHttpRequest',
    message:
      'Raw `XMLHttpRequest` bypasses the typed API client in `shared/api` (rules/api-contract.mdc).',
  },
];

/**
 * Web Storage survives a tab close and is readable by any script that lands on the page, so it is
 * the wrong home for anything that authenticates a request. Declared once and applied to both
 * layers that would plausibly reach for it — `units/auth`, which owns the session, and
 * `shared/api`, which owns the request that carries the token.
 */
const NO_PERSISTENT_TOKEN_STORAGE = ['localStorage', 'sessionStorage'].map((name) => ({
  name,
  message:
    'Auth tokens must not live in persistent storage — use an httpOnly cookie plus in-memory state (rules/security.mdc).',
}));

/**
 * The same ban, spelled through the global object.
 *
 * `no-restricted-globals` matches an unqualified identifier and nothing else, so
 * `globalThis.localStorage.setItem(...)` walked past it — measured while mutating the session store
 * to check that the invariant was actually held. Only the architecture test caught that form, which
 * means the fast feedback loop did not: a developer writing it sees a green `pnpm lint` and learns
 * the rule from a test run minutes later, if at all.
 */
const NO_PERSISTENT_TOKEN_STORAGE_PROPERTIES = [
  'error',
  ...['localStorage', 'sessionStorage'].flatMap((property) =>
    ['globalThis', 'window', 'self'].map((object) => ({
      object,
      property,
      message:
        'Auth tokens must not live in persistent storage — use an httpOnly cookie plus in-memory state (rules/security.mdc). Reaching it through the global object is the same storage.',
    })),
  ),
];

const NO_CONSOLE = ['error', { allow: ['warn', 'error'] }];

// ─── configuration reaches the code through a schema, never through a raw read ────────────────
const PROCESS_ENV_OUTSIDE_BOOTSTRAP = [
  'error',
  {
    object: 'process',
    property: 'env',
    message:
      'Read configuration from the parsed env object, not from `process.env`. The single sanctioned read is `infrastructure/bootstrap/load-env.util.ts`; anywhere else the variable escapes both the Zod schema and `.env.example` (rules/zod-validation.mdc rule 14, rules/security.mdc rule 17).',
  },
];

const IMPORT_META_ENV_OUTSIDE_CONFIG = {
  selector: "MemberExpression[object.type='MetaProperty'][property.name='env']",
  message:
    '`import.meta.env` is read once, in `shared/config`, and passed to `loadClientEnv`. Reading it here spreads unvalidated configuration through the app and makes it impossible to see what the bundle exposes (rules/zod-validation.mdc rule 14, rules/security.mdc rule 3).',
};

const TYPE_SAFETY_RULES = {
  '@typescript-eslint/consistent-type-imports': [
    'error',
    { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
  ],
  '@typescript-eslint/no-unused-vars': [
    'error',
    { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
  ],
  '@typescript-eslint/no-floating-promises': 'error',
  '@typescript-eslint/no-misused-promises': 'error',
  '@typescript-eslint/naming-convention': [
    'error',
    { selector: 'typeLike', format: ['PascalCase'] },
    {
      selector: 'variable',
      format: ['camelCase', 'PascalCase', 'UPPER_CASE'],
      leadingUnderscore: 'allow',
    },
    { selector: 'function', format: ['camelCase', 'PascalCase'] },
  ],
  'no-console': NO_CONSOLE,
  'no-debugger': 'error',
  'import/no-default-export': 'error',
  'import/no-duplicates': 'error',
  'import/order': [
    'error',
    {
      groups: [['builtin', 'external'], 'internal', ['parent', 'sibling', 'index']],
      'newlines-between': 'always',
    },
  ],
  'unicorn/filename-case': ['error', { case: 'kebabCase' }],
  'bad-crm/require-role-suffix': 'error',
};

/**
 * Layer aliases are their own import group, above the rest.
 *
 * `import/order` classifies `@units/session` as an external package — it is not relative and it is
 * not a configured internal path — so the layer imports had to sit in the same block as `react`
 * with no blank line between them. Naming them here makes the FSD layer a visible group in every
 * file, which is the point of having aliases at all. Client-only: the server's `@/…` alias has its
 * own arrangement and passes under the shared rule.
 */
const CLIENT_IMPORT_ORDER = [
  'error',
  {
    groups: [['builtin', 'external'], 'internal', ['parent', 'sibling', 'index']],
    // Braces, not `@(…)`: the latter is an extglob meaning "one of app|pages|…" and would never
    // match a specifier starting with `@`.
    pathGroups: [
      { pattern: '@{app,pages,widgets,units,shared}', group: 'internal', position: 'before' },
      { pattern: '@{app,pages,widgets,units,shared}/**', group: 'internal', position: 'before' },
    ],
    pathGroupsExcludedImportTypes: ['builtin'],
    'newlines-between': 'always',
  },
];

const TYPE_AWARE_LANGUAGE_OPTIONS = { parserOptions: { projectService: true } };

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/*.tsbuildinfo',
      '**/*.gen.ts',
      'packages/client/src/shared/api/schemas/**',
      // Deliberately broken sources, linted only by test/lint/architecture-rules.test.ts.
      'test/lint/fixtures/**',
    ],
  },

  // ── repo tooling: configs and repository-level tests, no type-aware rules ────────────────────
  {
    files: REPO_TOOLING,
    extends: [js.configs.recommended, ...tseslint.configs.recommended, prettier],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: globals.node },
    rules: { 'no-console': NO_CONSOLE, 'no-debugger': 'error' },
  },

  // ── shared: isomorphic, leaf of the package graph ────────────────────────────────────────────
  {
    files: [SHARED],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked, prettier],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', ...TYPE_AWARE_LANGUAGE_OPTIONS },
    plugins: { unicorn, import: importPlugin, 'bad-crm': badCrmPlugin },
    rules: {
      ...TYPE_SAFETY_RULES,
      'no-restricted-imports': ['error', { patterns: [SHARED_IS_LEAF] }],
      'no-restricted-globals': [
        'error',
        { name: 'window', message: '`shared` is isomorphic: no DOM and no Node globals.' },
        { name: 'document', message: '`shared` is isomorphic: no DOM and no Node globals.' },
        { name: 'process', message: '`shared` is isomorphic: no DOM and no Node globals.' },
      ],
    },
  },

  // ── server: hexagonal ────────────────────────────────────────────────────────────────────────
  {
    files: [SERVER],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked, prettier],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globals.node,
      ...TYPE_AWARE_LANGUAGE_OPTIONS,
    },
    plugins: { unicorn, import: importPlugin, 'bad-crm': badCrmPlugin },
    rules: {
      ...TYPE_SAFETY_RULES,
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            SERVER_STAYS_SERVER,
            NO_PARENT_RELATIVE,
            PRISMA_OUTSIDE_PERSISTENCE,
            DB_CLIENT_OUTSIDE_COMPOSITION_ROOT,
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        ...PRISMA_CALL_OUTSIDE_PERSISTENCE,
        UNSAFE_RAW_SQL,
        ARRAY_TRANSACTION,
      ],
      // Not switched off for `bootstrap/**`: the one legitimate read carries an inline disable with
      // a reason, so the exception is visible in the file that takes it rather than in this config.
      'no-restricted-properties': PROCESS_ENV_OUTSIDE_BOOTSTRAP,
    },
  },
  {
    files: [SERVER_DOMAIN],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            SERVER_STAYS_SERVER,
            NO_PARENT_RELATIVE,
            PRISMA_OUTSIDE_PERSISTENCE,
            DOMAIN_HAS_NO_IO,
            DOMAIN_IS_INNERMOST,
          ],
        },
      ],
    },
  },
  {
    files: [SERVER_APPLICATION],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            SERVER_STAYS_SERVER,
            NO_PARENT_RELATIVE,
            PRISMA_OUTSIDE_PERSISTENCE,
            APPLICATION_KNOWS_NO_ADAPTERS,
          ],
        },
      ],
    },
  },
  {
    files: [SERVER_PRESENTATION],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            SERVER_STAYS_SERVER,
            NO_PARENT_RELATIVE,
            PRISMA_OUTSIDE_PERSISTENCE,
            PRESENTATION_IS_THIN,
          ],
        },
      ],
    },
  },
  {
    // The one place Prisma exists: repositories run inside `withTenant(...)`.
    files: [SERVER_PERSISTENCE],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [SERVER_STAYS_SERVER, NO_PARENT_RELATIVE, DB_CLIENT_OUTSIDE_COMPOSITION_ROOT],
        },
      ],
      'no-restricted-syntax': ['error', UNSAFE_RAW_SQL, ARRAY_TRANSACTION],
    },
  },
  {
    /**
     * `database.factory.ts` *is* the module that opens the pool, so it is the one file that may
     * import `prisma.client.js`. Re-declared rather than switched off: `'off'` here would also lift
     * the package-boundary and parent-relative bans in the file that owns the connection.
     */
    files: [SERVER_DB_CLIENT_OWNER],
    rules: {
      'no-restricted-imports': ['error', { patterns: [SERVER_STAYS_SERVER, NO_PARENT_RELATIVE] }],
    },
  },
  {
    /**
     * The composition root, which calls `connectDatabase` — that is what a composition root is for.
     * `@prisma/client` itself stays banned here: the wiring passes a `DatabaseConnection` around
     * and never touches a Prisma type of its own.
     */
    files: [SERVER_COMPOSITION_ROOT],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [SERVER_STAYS_SERVER, NO_PARENT_RELATIVE, PRISMA_OUTSIDE_PERSISTENCE] },
      ],
    },
  },
  {
    /**
     * Declared after the persistence block so it wins, and it adds rather than replaces: a
     * repository keeps every ban of the layer it lives in and takes two more.
     */
    files: [SERVER_REPOSITORIES],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [SERVER_STAYS_SERVER, NO_PARENT_RELATIVE, DB_CLIENT_OUTSIDE_COMPOSITION_ROOT],
        },
      ],
      'no-restricted-syntax': [
        'error',
        UNSAFE_RAW_SQL,
        ARRAY_TRANSACTION,
        REPOSITORY_TAKES_NO_TENANT,
      ],
    },
  },
  {
    // The logger is the only module allowed to reach the console (rules/observability.mdc).
    files: [SERVER_LOGGING],
    rules: { 'no-console': 'off' },
  },

  // ── client: FSD ──────────────────────────────────────────────────────────────────────────────
  {
    files: [CLIENT],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked, prettier],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globals.browser,
      parserOptions: { ...TYPE_AWARE_LANGUAGE_OPTIONS.parserOptions, ecmaFeatures: { jsx: true } },
    },
    plugins: { unicorn, import: importPlugin, 'bad-crm': badCrmPlugin },
    rules: {
      ...TYPE_SAFETY_RULES,
      'import/order': CLIENT_IMPORT_ORDER,
      // Promised by `rules/frontend-fsd.mdc` and, until now, promised only there. Layer direction
      // (`app → pages → widgets → units → shared`) forbids a cycle *between* layers, and the
      // architecture tests check that; a cycle inside one layer — two barrels re-exporting through
      // each other — passes every one of those checks and surfaces at runtime as an import that is
      // `undefined` for no visible reason. `maxDepth` is left at the default: the shallow-only form
      // misses exactly the barrel-to-barrel chains this exists for.
      //
      // Requires the resolver configured in `settings` below. Enabled without it, the rule reports
      // nothing at all — every specifier in this package is either `@`-aliased or carries the `.js`
      // suffix of TypeScript ESM, and the node resolver can follow neither. Measured: a deliberate
      // two-file cycle passed a clean lint until the resolver was installed.
      'import/no-cycle': ['error', { ignoreExternal: true }],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            CLIENT_STAYS_CLIENT,
            NO_PARENT_RELATIVE,
            UNIT_DEEP_IMPORT,
            AXIOS_OUTSIDE_SHARED_API,
            NOTIFICATIONS_VIA_TOASTER,
          ],
        },
      ],
      'no-restricted-globals': ['error', ...NO_FETCH_GLOBALS],
      'no-restricted-syntax': ['error', IMPORT_META_ENV_OUTSIDE_CONFIG],
      'no-restricted-properties': PROCESS_ENV_OUTSIDE_BOOTSTRAP,
      // Declared on the whole client rather than on components only: a hook file under
      // `service/hooks` is exactly where an effect that should have been a query gets written.
      'bad-crm/no-effect-for-derived-state': 'error',
      'bad-crm/no-foreign-unit-internals': 'error',
    },
    // What lets `import/no-cycle` above resolve anything at all. The client writes every internal
    // specifier as an `@`-alias (`@units/auth`) or with the `.js` suffix TypeScript ESM requires
    // (`./x.util.js` for `x.util.ts`); the default node resolver follows neither, so the import
    // plugin sees an unresolvable specifier and stays quiet — a rule that is on and never fires.
    // The resolver reads the package's own `tsconfig.json`, which is where the aliases are declared
    // once (`shared/config/fsd-aliases.constant.ts` feeds it and `vite.config.ts` alike).
    // Absolute, not repository-relative: `pnpm lint` runs ESLint twice with two different working
    // directories — once from the repository root (`//#lint:repo`) and once from inside the package
    // (`@bad-crm/client#lint`). A relative path resolves in one of them and silently fails in the
    // other, and a resolver that cannot find its project reports no cycles rather than an error.
    settings: {
      'import/resolver': {
        typescript: { project: join(import.meta.dirname, 'packages/client/tsconfig.json') },
      },
      // Resolving is not enough. `no-cycle` has to *parse* each module it follows to find the edge
      // back, and the import plugin picks the parser by extension from this map; without it every
      // `.ts` dependency is unparseable, the graph stops at depth one, and the rule reports nothing.
      'import/parsers': { '@typescript-eslint/parser': ['.ts', '.tsx'] },
    },
  },
  {
    files: CLIENT_CONSUMERS,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            CLIENT_STAYS_CLIENT,
            NO_PARENT_RELATIVE,
            UNIT_DEEP_IMPORT,
            NO_DATA_LAYER_IN_CONSUMERS,
            NOTIFICATIONS_VIA_TOASTER,
          ],
        },
      ],
      'no-restricted-syntax': ['error', ...QUERY_HOOK_CALLS, IMPORT_META_ENV_OUTSIDE_CONFIG],
    },
  },
  {
    /**
     * The composition root. It may *import* the data layer — that is what assembling a provider
     * tree means — but it may not *fetch*: a `useQuery` here is a screen's data being loaded one
     * layer above the screen (`rules/frontend-fsd.mdc` rule 5, and its «Исключения» for `app/`).
     *
     * `only-throw-error` is narrowed rather than switched off. A route guard signals a redirect by
     * throwing the object `redirect()` returns — that is the router's control flow, not an error —
     * and it is a `Redirect`, not an `Error`. Everything else thrown here still has to be one.
     */
    files: [CLIENT_COMPOSITION_ROOT],
    rules: {
      'no-restricted-syntax': ['error', ...QUERY_HOOK_CALLS, IMPORT_META_ENV_OUTSIDE_CONFIG],
      '@typescript-eslint/only-throw-error': [
        'error',
        {
          allow: [
            { from: 'package', package: '@tanstack/router-core', name: 'Redirect' },
            { from: 'package', package: '@tanstack/react-router', name: 'Redirect' },
          ],
        },
      ],
    },
  },
  {
    /**
     * The two files that mount the notification container and load its stylesheet. Everything else
     * — including the rest of `app/**` — talks to `SharedUi.notify`.
     */
    files: ['packages/client/src/app/providers.tsx', 'packages/client/src/app/main.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            CLIENT_STAYS_CLIENT,
            NO_PARENT_RELATIVE,
            UNIT_DEEP_IMPORT,
            AXIOS_OUTSIDE_SHARED_API,
          ],
        },
      ],
    },
  },
  {
    /**
     * Route files are named by the router, not by us: `__root.tsx`, `_authenticated.tsx`,
     * `dashboard.tsx`. The generator reads the directory and the file name *is* the URL, so the
     * kebab-plus-role-suffix convention cannot apply — the same exemption
     * `rules/naming-and-structure.mdc` → «Исключения» already grants generated files. Everything
     * else about these files stays linted, including the a11y and React rules.
     */
    files: [CLIENT_ROUTE_FILES],
    rules: {
      'bad-crm/require-role-suffix': 'off',
      'unicorn/filename-case': 'off',
    },
  },
  {
    files: [CLIENT_UNITS],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            CLIENT_STAYS_CLIENT,
            NO_PARENT_RELATIVE,
            DEEP_IMPORT_INSIDE_UNITS,
            AXIOS_OUTSIDE_SHARED_API,
            UNITS_DO_NOT_LOOK_UP,
          ],
        },
      ],
    },
  },
  {
    // `api/` holds pure fetch functions; caching is the job of `service/{queries,mutations}`.
    files: [CLIENT_UNIT_API],
    rules: {
      'no-restricted-syntax': ['error', ...QUERY_HOOK_CALLS, IMPORT_META_ENV_OUTSIDE_CONFIG],
    },
  },
  {
    files: [CLIENT_SHARED],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            CLIENT_STAYS_CLIENT,
            NO_PARENT_RELATIVE,
            UNIT_DEEP_IMPORT,
            AXIOS_OUTSIDE_SHARED_API,
            SHARED_IS_DOMAIN_FREE,
            NOTIFICATIONS_VIA_TOASTER,
          ],
        },
      ],
    },
  },
  {
    /**
     * The one module allowed to speak to the notification vendor — it *is* the wrapper.
     *
     * Declared after the `shared` block so that it wins, and re-declared rather than switched off:
     * `'off'` here would lift every other import ban in the directory that owns the toaster.
     */
    files: ['packages/client/src/shared/ui/toaster/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            CLIENT_STAYS_CLIENT,
            NO_PARENT_RELATIVE,
            UNIT_DEEP_IMPORT,
            AXIOS_OUTSIDE_SHARED_API,
            SHARED_IS_DOMAIN_FREE,
          ],
        },
      ],
    },
  },

  {
    // The single place where the network physically lives (rules/frontend-fsd.mdc, "Исключения").
    //
    // The rule is re-declared with `fetch` dropped rather than switched off: `'off'` would lift
    // every *other* global ban in exactly the directory that owns the HTTP client and the code
    // that attaches credentials to a request — the most likely place for a token to end up in
    // `localStorage`. `XMLHttpRequest` stays banned; it bypasses the typed client either way.
    files: [CLIENT_SHARED_API],
    rules: {
      'no-restricted-globals': [
        'error',
        ...NO_FETCH_GLOBALS.filter((global) => global.name !== 'fetch'),
        ...NO_PERSISTENT_TOKEN_STORAGE,
      ],
      // The same ban in both spellings, and here for the same reason it is on the auth unit: this
      // is the layer that owns the request carrying the token. Declaring the identifier form alone
      // would have left half the client — the half that touches the credential on every call —
      // catching only the unqualified spelling.
      'no-restricted-properties': NO_PERSISTENT_TOKEN_STORAGE_PROPERTIES,
    },
  },
  {
    // The one place `import.meta.env` may be read: it is parsed by a Zod schema here and every
    // other layer imports the validated result (rules/security.mdc, rule 3).
    //
    // Again a re-declaration, not an `'off'`: the exemption is for the environment read alone.
    // `shared/config` parses configuration — it has no more business calling a TanStack Query hook
    // than any other non-unit layer (rules/frontend-fsd.mdc rule 5).
    files: [CLIENT_ENV_READERS],
    rules: { 'no-restricted-syntax': ['error', ...QUERY_HOOK_CALLS] },
  },
  {
    // Tokens never reach persistent storage (rules/security.mdc, invariant 3 in CLAUDE.md).
    files: [CLIENT_AUTH_UNIT],
    rules: {
      'no-restricted-globals': ['error', ...NO_FETCH_GLOBALS, ...NO_PERSISTENT_TOKEN_STORAGE],
      'no-restricted-properties': NO_PERSISTENT_TOKEN_STORAGE_PROPERTIES,
    },
  },
  {
    files: CLIENT_UI,
    extends: [
      react.configs.flat.recommended,
      react.configs.flat['jsx-runtime'],
      jsxA11y.flatConfigs.recommended,
    ],
    plugins: { 'react-hooks': reactHooks },
    settings: { react: { version: '19.0' } },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react/no-multi-comp': ['error', { ignoreStateless: false }],
      'react/jsx-no-useless-fragment': 'error',
      'react/no-danger': 'error',
      'react/forbid-dom-props': ['error', { forbid: ['style'] }],
      'react/forbid-component-props': ['error', { forbid: ['style'] }],
    },
  },

  // ── e2e: black-box suite ─────────────────────────────────────────────────────────────────────
  {
    files: [E2E],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked, prettier],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globals.node,
      ...TYPE_AWARE_LANGUAGE_OPTIONS,
    },
    plugins: { unicorn, import: importPlugin, 'bad-crm': badCrmPlugin },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      'no-console': NO_CONSOLE,
      'no-debugger': 'error',
      'unicorn/filename-case': ['error', { case: 'kebabCase' }],
      'bad-crm/require-role-suffix': 'error',
      'no-restricted-imports': ['error', { patterns: [E2E_IS_BLACK_BOX] }],
    },
  },

  // ── tests: no focused or empty specs slipping into a commit ──────────────────────────────────
  // Type-aware rules are off here on purpose: suites under `packages/*/test/**` and `test/**` live
  // outside the packages' `include`, so a type-aware parse would fail before any rule ran.
  {
    files: TESTS,
    extends: [js.configs.recommended, ...tseslint.configs.recommended, prettier],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globals.node,
      parserOptions: { projectService: false, project: false },
    },
    plugins: { vitest },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      ...vitest.configs.recommended.rules,
      'vitest/no-focused-tests': 'error',
      'vitest/no-disabled-tests': 'error',
      'vitest/expect-expect': 'error',
      // Vitest's own `expect(actual, message)` overload: the message is what turns "expected true
      // to be false" into a line naming the file under test. The rule defaults to Jest's arity.
      'vitest/valid-expect': ['error', { maxArgs: 2 }],
      // `describeForbidden(title, cases)` builds suites from a table, so the describe name is a
      // parameter rather than a literal. Titles of individual tests are still checked.
      'vitest/valid-title': ['error', { ignoreTypeOfDescribeName: true }],
      'bad-crm/require-role-suffix': 'off',
      '@typescript-eslint/naming-convention': 'off',
    },
  },

  // ── repository suite: every read goes through the recording door ─────────────────────────────
  // `//#test:repo` declares an `inputs` allow-list; a file the suite reads but `inputs` omits is
  // served from cache as a PASS over content that was never re-read. The set of files read is
  // therefore collected at read time by `readRepoFile`/`readJson` and audited in
  // `test/repo/workspace-layout.test.ts` — which only works while those two are the only way in.
  // A `readFileSync` written directly in a spec would be invisible to the audit, so the import is
  // banned everywhere in the suite except in the module that owns the registry.
  {
    files: REPO_SUITE,
    ignores: REPO_SUITE_FS_DOOR,
    rules: {
      'no-restricted-imports': ['error', { patterns: [READS_GO_THROUGH_THE_REGISTRY] }],
    },
  },
);
