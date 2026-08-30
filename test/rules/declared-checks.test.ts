import { describe, expect, it } from 'vitest';

import eslintConfig from '../../eslint.config.js';
import stylelintConfig from '../../stylelint.config.js';
import {
  KIND_NOTES,
  NON_SCRIPT_COMMANDS,
  claimKey,
  declaredChecks,
  fileClaimState,
  testFileClaimState,
  verificationRows,
  type ClaimKind,
  type DeclaredCheck,
} from './declared-checks.util.js';
import {
  PACKAGE_DIRS,
  listRepoFiles,
  readJson,
  readRepoFile,
} from '../repo/repo-fixture.util.js';

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const MANIFESTS = ['package.json', ...Object.values(PACKAGE_DIRS).map((dir) => `${dir}/package.json`)];

const manifests = (): PackageJson[] => MANIFESTS.map((path) => readJson<PackageJson>(path));

/** Every `scripts` key of the workspace — the complete surface `pnpm <name>` can resolve against. */
const scriptNames = (): Set<string> =>
  new Set(manifests().flatMap((manifest) => Object.keys(manifest.scripts ?? {})));

/** Every package the workspace installs, in any dependency kind. */
const dependencyNames = (): Set<string> =>
  new Set(
    manifests().flatMap((manifest) => [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ]),
  );

/**
 * The workflow a CI step is resolved against, as text.
 *
 * One file, not the five in `.github/workflows`: `ci.yml` is the one hashed into the inputs of
 * `//#test:repo`, and a suite that reads what its cache key does not cover reports a PASS over the
 * previous version of the file it never re-read — the exact defect this file exists to catch. A
 * step that lives in `codeql.yml`, `license-check.yml`, `dependency-review.yml` or
 * `pr-conventions.yml` is therefore named in a rule by its **file path**, which the `file` claim
 * resolves, rather than by a step name only this reader could check.
 */
const pullRequestWorkflow = (): string => readRepoFile('.github/workflows/ci.yml');

/**
 * The lint configuration as ESLint assembles it, not as the file reads.
 *
 * Grepping the source was the first attempt and it produced the false positive that would have
 * ended this test: `react-hooks/exhaustive-deps` is enabled through
 * `...reactHooks.configs.recommended.rules`, so the identifier appears nowhere in
 * `eslint.config.js` while the rule is unquestionably on. A promise checked against text would have
 * called that a lie. The resolved array has no such gap — a preset spread, a shared constant and an
 * inline entry all end up as the same key.
 */
const configEntries = (): { rules?: Record<string, unknown> }[] =>
  eslintConfig as { rules?: Record<string, unknown> }[];

/**
 * Rule ids that are switched *on* somewhere, which is a stricter reading than "mentioned".
 *
 * `'bad-crm/require-role-suffix': 'off'` in the suite's own block is a rule the repository knows
 * about and does not run there; a rule set to `off` in every block enforces nothing at all, and a
 * table that names it is making the same promise as a table naming a rule that does not exist.
 */
const activeRuleNames = (): Set<string> => {
  const active = new Set<string>();

  for (const entry of configEntries()) {
    for (const [name, setting] of Object.entries(entry.rules ?? {})) {
      const severity = Array.isArray(setting) ? setting[0] : setting;
      if (severity !== 'off' && severity !== 0) active.add(name);
    }
  }

  return active;
};

/**
 * The options of every configured rule, serialised.
 *
 * This is where a restricted subject lives: the `group` of a `no-restricted-imports` pattern, the
 * `selector` string of a `no-restricted-syntax` entry. Serialising the resolved options rather than
 * reading the file keeps prose out of the haystack — a selector named only in a comment explaining
 * why it *should* exist would otherwise satisfy the promise it fails to keep.
 */
const ruleOptions = (): string =>
  JSON.stringify(configEntries().map((entry) => entry.rules ?? {}));

const stylelintRuleNames = (): Set<string> =>
  new Set(Object.keys((stylelintConfig as { rules?: Record<string, unknown> }).rules ?? {}));

const ruleFiles = (): string[] =>
  listRepoFiles('rules')
    .filter((path) => path.endsWith('.mdc'))
    .sort();

const allChecks = (): DeclaredCheck[] => {
  const isDependency = (name: string): boolean => dependencyNames().has(name);

  return ruleFiles().flatMap((path) =>
    declaredChecks(path.slice('rules/'.length), readRepoFile(path), isDependency),
  );
};

const isSatisfied = (check: DeclaredCheck): boolean => {
  switch (check.kind) {
    case 'eslint-rule':
      return activeRuleNames().has(check.identifier) || stylelintRuleNames().has(check.identifier);
    case 'eslint-subject':
      return ruleOptions().includes(check.identifier);
    case 'command':
      return scriptNames().has(check.identifier);
    case 'file':
      return fileClaimState(check.identifier) !== 'missing';
    case 'ci-step':
      return scriptNames().has(check.identifier) || pullRequestWorkflow().includes(check.identifier);
    case 'test-file':
      return testFileClaimState(check.identifier) === 'satisfied';
    case 'tool':
      return dependencyNames().has(check.identifier);
  }
};

/**
 * Promises that are real work, not lies — every one of them, with the reason it is not there yet.
 *
 * This registry is the price of reading a rule set written for the destination while the product is
 * at EPIC-005 of fifty. A row promising `bad-crm/no-adhoc-query-key` is not false; it is the
 * specification the epic that writes that lint rule will be held to. What is *not* acceptable is
 * that state being invisible — which is precisely how `$transaction([...])` sat unenforced in
 * `rules/tenancy-rls.mdc` for five epics until a human happened to look.
 *
 * So the deal is: a promise may outrun its implementation, but only in writing. An undeclared gap
 * fails below, and so does a declared gap that has since been implemented — a stale entry here is
 * the same document-that-lies defect pointing the other way.
 */
const PENDING: Readonly<Record<string, string>> = {
  // ── OpenAPI and HTTP semantics (EPIC-003 in review, idempotency scheduled with M2) ───────────
  'api-contract.mdc · file · test/integration/http/idempotency.test.ts':
    'There is no idempotency middleware yet — the `Idempotency-Key` handling lands with the first ' +
    'mutating resource endpoints in M2, and the suite is written against it.',

  // ── custom ESLint rules of the repository plugin, none of them written yet ───────────────────
  'design-system.mdc · eslint-rule · bad-crm/classnames-via-clsx':
    '`eslint/bad-crm.plugin.js` ships three rules and this is not one of them; the design system ' +
    'itself is EPIC-007 and no component yet composes a className conditionally.',
  'errors-and-toasts.mdc · eslint-rule · bad-crm/no-toast-in-onerror-query':
    'Not implemented in `eslint/bad-crm.plugin.js`. The invariant it would enforce is covered today ' +
    'by `packages/client/test/api/query-client.test.ts`, which asserts a failing query is logged and not toasted.',
  'lists-and-filters.mdc · eslint-rule · bad-crm/no-usestate-for-search-params':
    'Not implemented in `eslint/bad-crm.plugin.js`; no filtered list exists yet, so the rule has ' +
    'nothing to run against until the first `validateSearch` route lands.',
  'naming-and-structure.mdc · eslint-rule · bad-crm/no-inline-helpers':
    'Not implemented in `eslint/bad-crm.plugin.js`. `bad-crm/require-role-suffix` covers the file ' +
    'naming half of this rule; the helper-inside-a-component half is still reviewed by hand.',
  'realtime.mdc · eslint-rule · bad-crm/no-io-emit-global':
    'Not implemented in `eslint/bad-crm.plugin.js`. Realtime infrastructure is EPIC-025 — there is ' +
    'no socket server in the tree for the rule to guard.',
  'tanstack-query.mdc · eslint-rule · bad-crm/no-adhoc-query-key':
    'Not implemented in `eslint/bad-crm.plugin.js`. The query-key factory exists in ' +
    '`packages/client/src/shared/lib/enums`, but nothing yet stops a literal array at a call site.',
  'tanstack-query.mdc · eslint-rule · bad-crm/require-signal-in-queryfn':
    'Not implemented in `eslint/bad-crm.plugin.js`. The client has one query hook so far and it is ' +
    'reviewed by hand; the rule belongs with the first list screen that can race.',
  'zod-validation.mdc · eslint-rule · bad-crm/no-interface-next-to-schema':
    'Not implemented in `eslint/bad-crm.plugin.js`. Schema-first is followed by convention today ' +
    'and checked by the reviewer, not by the linter.',

  // ── third-party lint plugins the workspace does not install ──────────────────────────────────
  'frontend-fsd.mdc · eslint-rule · boundaries/element-types':
    '`eslint-plugin-boundaries` is not a dependency. The layer directions it would express are ' +
    'enforced today by `no-restricted-imports` groups per `files` block plus `test/architecture/layers.test.ts`, ' +
    'which walks the real import graph — the plugin would replace that pair, not add to it.',
  // ── commands that belong to the i18n epic ────────────────────────────────────────────────────
  'i18n.mdc · command · i18n:unused':
    'Same as `i18n:check`: the script is specified against a message catalogue that EPIC-008 introduces.',

  // ── CI steps and jobs the workflows do not have ──────────────────────────────────────────────
  'dependencies.mdc · ci-step · check:forbidden-packages':
    'No step checks the ban list of §11 against the tree. `test/deps/quarantined-versions.test.ts` ' +
    'is a different gate — it refuses *versions* poisoned by the 2026-08-04 worm, not packages ' +
    'forbidden for licensing. The premium and Elasticsearch bans rest on review today.',
  'editor-content.mdc · ci-step · check:blocknote-xl':
    'No `@blocknote/*` package is installed: the editor is EPIC-030 and ADR-0012 is a decision ' +
    'taken ahead of it. The step belongs with the first BlockNote dependency, not before it.',
  'epic-driven-development.mdc · ci-step · check:story-frontmatter':
    'Nothing parses the frontmatter of `epics/**/stories/*.md`. Two epics in `in-progress` at once, ' +
    'an unknown status or a missing `milestone` are caught by the person reading the board today.',
  'epic-driven-development.mdc · ci-step · check:rules-links':
    'Nothing resolves the `rules/*.mdc` links a story cites. A renamed rule leaves dead links in ' +
    'every story that named it, and only a reader following one finds out.',
  'self-host-packaging.mdc · ci-step · compose-up-full':
    'CI brings the stack up on the `minimal` profile only, inside the `end-to-end` job. The `full` ' +
    'profile — Meilisearch and the AI services — is started by hand when it is touched.',
  'self-host-packaging.mdc · ci-step · upgrade-path':
    'There is no released image to upgrade *from*: the product is pre-alpha and EPIC-017 is what ' +
    'first publishes one. `test/infra/upgrade-runbook.test.ts` holds the written procedure ' +
    'meanwhile — the order of role bootstrap and migrations — but nothing executes it.',
  'self-host-packaging.mdc · ci-step · check:published-ports':
    'There is no `docker-compose.prod.yml` in the tree to parse. `test/infra/compose.test.ts` ' +
    'asserts the same property for the dev file — every published port bound to `127.0.0.1` — and ' +
    'the production compose arrives with the packaging epic that will need this step with it.',
  'e2ee-crypto.mdc · ci-step · units/vault/**':
    'There is no `units/vault` in the tree to grep — the vault is M4 (EPIC-048). The identifier is ' +
    'the scope of the promised grep rather than a step name, because the row names no step: the ' +
    'epic that writes the vault writes this check, and gives it a name then.',

  // ── suites named without a directory, for domains that do not exist yet ──────────────────────
  'api-contract.mdc · test-file · pagination-contract.test.ts':
    'No endpoint paginates yet, so there is no cursor and no `limit` for a contract test to hold. ' +
    'The pagination primitives exist (`packages/shared/src/validation/pagination.schema.ts`); the ' +
    'suite belongs with the first list endpoint that uses them.',
  'file-uploads.mdc · test-file · orphan-files.test.ts':
    'There is no file domain and no reaper job — files are EPIC-015. The suite is specified ' +
    'against the job that will delete unreferenced objects, and there is nothing to run it on.',
  'permissions.mdc · test-file · list-matches-can.test.ts':
    'The property is «a list endpoint returns exactly what a per-row `can()` would», and no domain ' +
    'has a resource ACL to disagree about yet — STORY-011-06 is blocked on EPIC-014 for the same ' +
    'reason. The employee directory filters in SQL under `withTenant` and is covered by ' +
    '`packages/server/test/integration/db/employee-directory-isolation.test.ts`.',

  // ── packages named as mechanisms that the workspace does not install ─────────────────────────
  'a11y.mdc · tool · @storybook/addon-a11y':
    'There is no component workshop: STORY-008-06 is open precisely because the tool has not been ' +
    'chosen and needs an ADR. Nothing in this row is enforced today, and the component-level axe ' +
    'row above it is what actually covers `shared/ui`.',
  'hexagonal-backend.mdc · tool · eslint-plugin-boundaries':
    'Not a dependency, for the same reason as in `rules/frontend-fsd.mdc`: the server layer ' +
    'directions are enforced by `no-restricted-imports` groups per `files` block plus ' +
    '`packages/server/test/unit/architecture/layers.test.ts`, which walks the real import graph. ' +
    'The plugin would replace that pair rather than add to it.',

  // ── suites specified for subsystems that are not built ───────────────────────────────────────
  'outbox.mdc · file · test/architecture/no-io-in-transaction.test.ts':
    'There is no outbox and no queue in the tree; the suite is specified against the transactional ' +
    'publish path that epic introduces.',
  'self-host-packaging.mdc · file · test/integration/shutdown.test.ts':
    'Half of it exists as a unit test — `packages/server/test/unit/bootstrap/shutdown.test.ts` covers ' +
    'the handler and its deadline. The `/ready → 503` half needs a live server and belongs to the integration suite.',
  'time-tracking-invariants.mdc · file · test/architecture/no-raw-time-aggregate.test.ts':
    'There are no `time_entries` and no reporting paths in the tree; the suite is specified against ' +
    'the aggregation layer of the time-tracking epics.',
};

describe('the extractor reads the verification tables and nothing else', () => {
  const FIXTURE = [
    '# Fixture',
    '',
    '## Правило',
    '',
    '1. ESLint `no-restricted-syntax` на `$nowhere` — prose outside the table is not a claim.',
    '',
    '## Как проверяется',
    '',
    '| Механизм | Что ловит |',
    '|---|---|',
    '| ESLint `no-restricted-syntax` на `$transaction([...])` | batch instead of interactive |',
    '| Кастомное ESLint-правило `bad-crm/no-such-rule` | nothing, it does not exist |',
    '| `pnpm check:rls` (`packages/server/scripts/check-rls.ts`) на живом хосте | tables without RLS |',
    '| `pnpm no-such-script` | nothing, it does not exist |',
    '| ESLint `no-restricted-imports` на UI-библиотеки, кроме `@tabler/icons-react` | a second UI kit |',
    '| Агент `db-reviewer` в commit-гейте | миграции и индексы |',
    '',
    '## Исключения',
    '',
    '| Механизм | Что ловит |',
    '|---|---|',
    '| ESLint `bad-crm/not-a-claim-either` | a table outside the verification section |',
  ].join('\n');

  const fixtureChecks = (): DeclaredCheck[] =>
    declaredChecks('fixture.mdc', FIXTURE, (name) => name === '@tabler/icons-react');

  const identifiers = (kind: ClaimKind): string[] =>
    fixtureChecks()
      .filter((check) => check.kind === kind)
      .map((check) => check.identifier);

  it('takes rows from the «Как проверяется» table only', () => {
    expect(verificationRows(FIXTURE)).toHaveLength(6);
  });

  it('reads the rule id and the subject of a restriction', () => {
    expect(identifiers('eslint-rule')).toEqual([
      'no-restricted-syntax',
      'bad-crm/no-such-rule',
      'no-restricted-imports',
    ]);
    expect(identifiers('eslint-subject')).toEqual(['$transaction']);
  });

  /**
   * The false positive that would end this test: a package named as *allowed* read as a package
   * named as *forbidden*. `@tabler/icons-react` is a real dependency, so nothing but the adjacency
   * of the preposition tells the two apart.
   */
  it('does not read an exception list as a restriction', () => {
    expect(identifiers('eslint-subject')).not.toContain('@tabler/icons-react');
  });

  it('reads commands and the files beside them', () => {
    expect(identifiers('command')).toEqual(['check:rls', 'no-such-script']);
    expect(identifiers('file')).toEqual(['packages/server/scripts/check-rls.ts']);
  });

  it('reads nothing out of a row that names an agent rather than a mechanism', () => {
    expect(fixtureChecks().some((check) => check.identifier.includes('db-reviewer'))).toBe(false);
  });

  /**
   * The positive control, and the reason this file is a gate rather than a description: a rule
   * that promises a check nobody wrote has to come out of the extractor as a promise, and the audit
   * below has to be able to fail on it. Three of the fixture's six rows are exactly that shape.
   */
  it('surfaces a promise nothing implements', () => {
    // A lint configuration that really does ban the array form, and really does not have the
    // custom rule the second row promises.
    const lint = [
      "'no-restricted-syntax': ['error', UNSAFE_RAW_SQL, ARRAY_TRANSACTION],",
      "'no-restricted-imports': ['error', { patterns: [SHARED_IS_LEAF] }],",
      "selector: \"CallExpression[callee.property.name='$transaction']\",",
    ].join('\n');
    const scripts = new Set(['check:rls']);

    const unsatisfied = fixtureChecks().filter((check) => {
      if (check.kind === 'command') return !scripts.has(check.identifier);
      if (check.kind === 'file') return false;
      return !lint.includes(check.identifier);
    });

    expect(unsatisfied.map((check) => check.identifier)).toEqual([
      'bad-crm/no-such-rule',
      'no-such-script',
    ]);
  });
});

/**
 * The three shapes a promise used to leave through, each with its own fixture row and its own
 * control on the detector.
 *
 * All three were found the same way and hid for the same reason: the extractor read four kinds of
 * token, and a rule that phrased its mechanism as anything else went out unread. An unread promise
 * is indistinguishable from a kept one in the report, which is worse than no report — twelve
 * promises of checks nobody wrote passed through, and the suite stayed green over every one.
 */
describe('the extractor reads the three shapes that used to pass through', () => {
  const FIXTURE = [
    '## Как проверяется',
    '',
    '| Механизм | Что ловит |',
    '|---|---|',
    '| CI-шаг `check:env-parity` (`.env.example` ↔ zod-схема) | переменную мимо схемы |',
    '| CI-джоб `compose-up-minimal`: `--profile minimal` + e2e | функцию без деградации |',
    '| CI-шаг `pnpm install --frozen-lockfile` | разъехавшийся lockfile |',
    '| grep-чек CI: `SET\\s+app\\.organization_id` | `SET` без `LOCAL` |',
    '| Тест `pagination-contract.test.ts` | курсор без tie-breaker |',
    '| Тест `declared-checks.test.ts` | обещание несуществующей проверки |',
    '| Компонентный тест (Vitest, `*.test.tsx`) на каждую модалку | модалку без ловушки |',
    '| `vitest-axe` в компонентных тестах `shared/ui` | недоступный компонент |',
    '| `@axe-core/playwright` в e2e — падение сборки на `serious`/`critical` | регрессии |',
    '| `pnpm audit` + `osv-scanner` в CI | известные CVE |',
    '| `import/no-cycle` | циклические зависимости |',
    '| ESLint `no-restricted-imports` на `@prisma/client` вне слоя | утечку Prisma |',
  ].join('\n');

  const fixtureChecks = (): DeclaredCheck[] =>
    declaredChecks('fixture.mdc', FIXTURE, (name) => name === '@prisma/client');

  const identifiers = (kind: ClaimKind): string[] =>
    fixtureChecks()
      .filter((check) => check.kind === kind)
      .map((check) => check.identifier);

  /**
   * A CI step is named, not quoted: `pnpm install --frozen-lockfile` is a command line the
   * `command` claim already resolves, and reading it here a second time would report the same
   * promise twice under two names.
   */
  it('reads the name of a CI step, a CI job and a CI grep', () => {
    expect(identifiers('ci-step')).toEqual([
      'check:env-parity',
      'compose-up-minimal',
      String.raw`SET\s+app\.organization_id`,
    ]);
  });

  it('reads a test file named without its directory, and not a naming convention', () => {
    expect(identifiers('test-file')).toEqual([
      'pagination-contract.test.ts',
      'declared-checks.test.ts',
    ]);
  });

  /**
   * The false positive that would end this half: `import/no-cycle` opens its cell exactly the way
   * a package does, and `serious`/`critical` are kebab-shaped words sitting in the same sentence as
   * a real package name. Only the rule-id shape and the adjacency of the enumeration tell them
   * apart from `osv-scanner`, which is a package and is named as the mechanism.
   */
  it('reads a package named as the mechanism, and neither a rule id nor a word beside one', () => {
    expect(identifiers('tool')).toEqual(['vitest-axe', '@axe-core/playwright', 'osv-scanner']);
  });

  it('leaves the restricted subject of a lint row to the lint claim', () => {
    expect(identifiers('tool')).not.toContain('@prisma/client');
    expect(identifiers('eslint-subject')).toEqual(['@prisma/client']);
  });

  /**
   * The control on each detector: an invented identifier of every new kind has to come out
   * unsatisfied, and a real one of the same kind has to come out satisfied. Without the second
   * half a detector that resolves nothing would look like a detector that found everything.
   */
  it.each([
    ['ci-step', 'check:no-such-step', false],
    ['ci-step', 'test:repo', true],
    ['ci-step', 'pnpm turbo run typecheck lint build test', true],
    ['test-file', 'no-such-suite.test.ts', false],
    ['test-file', 'declared-checks.test.ts', true],
    ['tool', 'no-such-package-anywhere', false],
    ['tool', 'size-limit', true],
  ] as const)('resolves the %s claim `%s` to %s', (kind, identifier, expected) => {
    expect(isSatisfied({ rule: 'fixture.mdc', kind, identifier, row: '' })).toBe(expected);
  });
});

describe('the file claim abstains where the subsystem does not exist', () => {
  it.each([
    ['test/architecture/layers.test.ts', 'satisfied'],
    ['test/integration/db/rls-isolation.test.ts', 'satisfied'],
    ['test/architecture/no-such-suite.test.ts', 'missing'],
    ['test/integration/ai/limits.spec.ts', 'abstained'],
  ])('reports %s as %s', (identifier, expected) => {
    expect(fileClaimState(identifier)).toBe(expected);
  });
});

describe('every mechanical check the rules promise exists', () => {
  /**
   * A suite that extracted nothing would pass every assertion below over an empty set, which is the
   * failure mode of every parser written against prose. The floor and the named anchors are what
   * make the green above mean something.
   */
  it('extracts a non-trivial number of claims', () => {
    expect(allChecks().length).toBeGreaterThan(60);
  });

  it.each([
    ['tenancy-rls.mdc', 'eslint-subject', '$transaction'],
    ['tenancy-rls.mdc', 'eslint-subject', '$queryRawUnsafe'],
    ['tenancy-rls.mdc', 'eslint-subject', '@prisma/client'],
    ['tenancy-rls.mdc', 'command', 'check:rls'],
    ['tenancy-rls.mdc', 'file', 'packages/server/scripts/check-rls.ts'],
    ['testing.mdc', 'eslint-rule', 'vitest/no-focused-tests'],
    ['naming-and-structure.mdc', 'eslint-rule', 'bad-crm/require-role-suffix'],
    ['frontend-fsd.mdc', 'file', 'test/architecture/layers.test.ts'],
  ])('extracts the %s claim about `%s %s`', (rule, kind, identifier) => {
    expect(allChecks().map(claimKey)).toContain(`${rule} · ${kind} · ${identifier}`);
  });

  it('holds every promise the repository has not declared as pending', () => {
    const broken = allChecks()
      .filter((check) => !isSatisfied(check))
      .filter((check) => PENDING[claimKey(check)] === undefined);

    expect(
      broken.map((check) => `${claimKey(check)}  ←  ${check.row}`),
      'a rule promises a mechanical check that does not exist',
    ).toEqual([]);
  });

  /**
   * The other direction, and the one that actually rots: an entry that describes a gap somebody has
   * since closed. Left in place it turns this registry back into the thing it exists to prevent — a
   * document asserting something about the repository that stopped being true.
   */
  it('declares nothing as pending that already exists', () => {
    const satisfied = new Set(allChecks().filter(isSatisfied).map(claimKey));
    const stale = Object.keys(PENDING).filter((key) => satisfied.has(key));

    expect(stale, 'implemented since; remove the entry from PENDING').toEqual([]);
  });

  it('declares nothing as pending that the extractor no longer produces', () => {
    const known = new Set(allChecks().map(claimKey));

    expect(Object.keys(PENDING).filter((key) => !known.has(key))).toEqual([]);
  });

  it('gives every pending promise a reason long enough to be one', () => {
    for (const [key, reason] of Object.entries(PENDING)) {
      expect(reason.length, key).toBeGreaterThan(40);
    }
  });

  it.each(Object.entries(NON_SCRIPT_COMMANDS))('explains why `pnpm %s` is not a script', (_name, reason) => {
    expect(reason.length).toBeGreaterThan(20);
  });

  it.each(Object.entries(KIND_NOTES))('documents the namespace behind the %s claim', (_kind, note) => {
    expect(note.length).toBeGreaterThan(80);
  });
});
