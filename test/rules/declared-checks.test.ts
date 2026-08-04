import { describe, expect, it } from 'vitest';

import eslintConfig from '../../eslint.config.js';
import stylelintConfig from '../../stylelint.config.js';
import {
  KIND_NOTES,
  NON_SCRIPT_COMMANDS,
  claimKey,
  declaredChecks,
  fileClaimState,
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
  'api-contract.mdc · command · api:lint':
    'Spectral is not installed and no `api:lint` script exists; the specification is currently held ' +
    'by `packages/server/test/contract/openapi.test.ts` in both directions, which is a different check.',
  'api-contract.mdc · file · test/integration/http/idempotency.spec.ts':
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
  'testing.mdc · eslint-rule · bad-crm/no-network-in-tests':
    'Not implemented in `eslint/bad-crm.plugin.js`. The ban on network from a test is currently a ' +
    'review item only — the closest mechanical guard is that no test imports a fetch client.',
  'zod-validation.mdc · eslint-rule · bad-crm/no-interface-next-to-schema':
    'Not implemented in `eslint/bad-crm.plugin.js`. Schema-first is followed by convention today ' +
    'and checked by the reviewer, not by the linter.',

  // ── third-party lint plugins the workspace does not install ──────────────────────────────────
  'frontend-fsd.mdc · eslint-rule · boundaries/element-types':
    '`eslint-plugin-boundaries` is not a dependency. The layer directions it would express are ' +
    'enforced today by `no-restricted-imports` groups per `files` block plus `test/architecture/layers.test.ts`, ' +
    'which walks the real import graph — the plugin would replace that pair, not add to it.',
  'i18n.mdc · file · test/i18n/plural.spec.ts':
    'Pluralisation lands with the first countable string. EPIC-008 has the catalogues and the ' +
    'instance (STORY-008-01) and no plural yet — 26 keys, none of them counted — so the suite would ' +
    'assert `one/few/many` about nothing.',

  'i18n.mdc · eslint-rule · i18next/no-literal-string':
    '`eslint-plugin-i18next` is not a dependency and the application is single-language until ' +
    'EPIC-008; turning the rule on now would flag every string in the tree.',

  // ── commands that belong to the i18n epic ────────────────────────────────────────────────────
  'i18n.mdc · command · i18n:check':
    'No translation trees exist yet (EPIC-008), so there is nothing for a key-parity script to compare.',
  'i18n.mdc · command · i18n:unused':
    'Same as `i18n:check`: the script is specified against a message catalogue that EPIC-008 introduces.',

  // ── suites specified for subsystems that are not built ───────────────────────────────────────
  'naming-and-structure.mdc · file · test/architecture/unit-names.spec.ts':
    'No suite reads `docs/product/glossary.md` yet. `test/architecture/structure.test.ts` checks the ' +
    'shape of `units/*` but not the vocabulary of their names.',
  'outbox.mdc · file · test/architecture/no-io-in-transaction.spec.ts':
    'There is no outbox and no queue in the tree; the suite is specified against the transactional ' +
    'publish path that epic introduces.',
  'permissions.mdc · file · test/permissions/route-registry.spec.ts':
    'The route registry carries no permission declarations yet (EPIC-011); ' +
    '`packages/server/test/unit/http/route-registry.test.ts` checks the registry against Express and stops there.',
  'permissions.mdc · file · test/permissions/acl-coverage.spec.ts':
    'ACL levels are declared in the shared catalogue but no resource endpoint consumes them yet, so ' +
    'the coverage this suite measures would be measured over an empty set (EPIC-011).',
  'permissions.mdc · file · test/permissions/permission-matrix.test.ts':
    'The role x endpoint matrix and its committed snapshot arrive with EPIC-011; ' +
    '`packages/shared/test/permissions/catalog.test.ts` holds the catalogue itself in the meantime.',
  'self-host-packaging.mdc · file · test/integration/shutdown.spec.ts':
    'Half of it exists as a unit test — `packages/server/test/unit/bootstrap/shutdown.test.ts` covers ' +
    'the handler and its deadline. The `/ready → 503` half needs a live server and belongs to the integration suite.',
  'time-tracking-invariants.mdc · file · test/architecture/no-raw-time-aggregate.spec.ts':
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
