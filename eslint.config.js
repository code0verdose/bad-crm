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
const SERVER_LOGGING = 'packages/server/src/infrastructure/logging/**/*.ts';
const CLIENT = 'packages/client/src/**/*.{ts,tsx}';
const CLIENT_CONSUMERS = [
  'packages/client/src/app/**/*.{ts,tsx}',
  'packages/client/src/pages/**/*.{ts,tsx}',
  'packages/client/src/widgets/**/*.{ts,tsx}',
];
const CLIENT_UNITS = 'packages/client/src/units/**/*.{ts,tsx}';
const CLIENT_UNIT_API = 'packages/client/src/units/*/api/**/*.ts';
const CLIENT_SHARED = 'packages/client/src/shared/**/*.{ts,tsx}';
const CLIENT_SHARED_API = 'packages/client/src/shared/api/**/*.ts';
/** The only client layer allowed to touch `import.meta.env`; everything else imports the result. */
const CLIENT_ENV_READERS = 'packages/client/src/shared/config/**/*.ts';
const CLIENT_AUTH_UNIT = 'packages/client/src/units/auth/**/*.{ts,tsx}';
const CLIENT_UI = [
  'packages/client/src/pages/**/*.tsx',
  'packages/client/src/widgets/**/*.tsx',
  'packages/client/src/units/*/ui/**/*.tsx',
];
const E2E = 'packages/e2e/{src,tests}/**/*.ts';
const TESTS = [
  'packages/*/test/**/*.ts',
  'packages/**/*.{test,spec}.{ts,tsx}',
  'test/**/*.test.ts',
];
const REPO_TOOLING = ['*.js', '*.ts', 'test/**/*.ts', 'eslint/**/*.js'];

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

// ─── client: FSD layers (rules/frontend-fsd.mdc, rules/tanstack-query.mdc) ────────────────────
const UNIT_DEEP_IMPORT = {
  group: ['@units/*/*', '@units/*/**', '@shared/*/*/**', '@app/*/*/**', '@widgets/*/*/**'],
  message:
    'A unit exposes exactly one public surface — its namespace barrel. Import `{ TaskService } from "@units/task"`, never a path inside the unit (rules/frontend-fsd.mdc, rule 3).',
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
        { patterns: [SERVER_STAYS_SERVER, NO_PARENT_RELATIVE, PRISMA_OUTSIDE_PERSISTENCE] },
      ],
      'no-restricted-syntax': ['error', ...PRISMA_CALL_OUTSIDE_PERSISTENCE, UNSAFE_RAW_SQL],
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
      'no-restricted-imports': ['error', { patterns: [SERVER_STAYS_SERVER, NO_PARENT_RELATIVE] }],
      'no-restricted-syntax': ['error', UNSAFE_RAW_SQL],
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
      'no-restricted-globals': ['error', ...NO_FETCH_GLOBALS],
      'no-restricted-syntax': ['error', IMPORT_META_ENV_OUTSIDE_CONFIG],
      'no-restricted-properties': PROCESS_ENV_OUTSIDE_BOOTSTRAP,
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
          ],
        },
      ],
      'no-restricted-syntax': ['error', ...QUERY_HOOK_CALLS, IMPORT_META_ENV_OUTSIDE_CONFIG],
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
            UNIT_DEEP_IMPORT,
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
);
