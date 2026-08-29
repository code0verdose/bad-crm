import { PACKAGE_DIRS, listRepoFiles, repoEntryNames } from '../repo/repo-fixture.util.js';

/**
 * The kinds of promise this extractor is willing to read out of a rule.
 *
 * Each one resolves against a namespace that is *complete in this checkout*, which is the whole
 * reason the list is this short. `rules/*.mdc` describe the destination of a product that is at
 * EPIC-005 of fifty, so most of what the tables promise is a specification for an epic that has not
 * run yet — a naive reader would report a hundred "missing" checks, and the first person to hit
 * that wall would delete the test rather than the wall. See `KIND_NOTES` for what each namespace is
 * and why it is closed.
 */
export type ClaimKind =
  | 'eslint-rule'
  | 'eslint-subject'
  | 'command'
  | 'file'
  | 'ci-step'
  | 'test-file'
  | 'tool';

/** Why each kind is safe to resolve today — quoted into the report, and asserted non-empty. */
export const KIND_NOTES: Readonly<Record<ClaimKind, string>> = {
  'eslint-rule':
    'The lint configuration is whole: there is one `eslint.config.js` and one `eslint/bad-crm.plugin.js`, ' +
    'and no partial or future copy of either. A rule id named in a table either appears in them or does not.',
  'eslint-subject':
    'The identifier a `no-restricted-*` entry is keyed on, in the two shapes the tables actually write ' +
    'machine-readably: a `$`-prefixed client member (`$transaction`, `$queryRawUnsafe`) and an installed ' +
    'package specifier. Both resolve against the same closed lint sources as the rule id.',
  command:
    'The command surface is whole: the `scripts` of the root and of every workspace package. A `pnpm …` ' +
    'in a table is an instruction a contributor can follow right now, or it is wrong right now.',
  file:
    'A path is resolved only when the directory around it already exists — see `fileClaimState`. ' +
    'A path whose whole subtree is absent belongs to an unbuilt subsystem and is abstained on.',
  'ci-step':
    'The name a row gives a CI step, job or grep, resolved against two closed surfaces: the `scripts` ' +
    'of the workspace and the text of `.github/workflows/ci.yml`, the workflow that runs on every ' +
    'pull request. A step living in one of the other four workflow files is named here by its file ' +
    'path instead, which the `file` claim resolves — those files are not hashed into this task, and ' +
    'a suite that reads what its cache key does not cover reports a PASS over the previous version.',
  'test-file':
    'A test file named without its directory, resolved as a basename over every directory a Vitest ' +
    'or Playwright suite may live in: `test/`, `scripts/` and each package’s `src/`, `test/` and ' +
    '`tests/`. The namespace is complete because the runner configs accept no other location, so a ' +
    'basename found nowhere is found nowhere — there is no third state to abstain into.',
  tool:
    'An npm package named as the mechanism itself, resolved against every dependency the workspace ' +
    'installs. Read only where the cell *opens* with it, or where an enumeration continues one that ' +
    'did: a package named further into a sentence is being described, not promised, and the tables ' +
    'are full of kebab-shaped words that are not packages at all.',
};

export interface DeclaredCheck {
  /** File name of the rule, e.g. `tenancy-rls.mdc`. */
  readonly rule: string;
  readonly kind: ClaimKind;
  /** The resolved identifier: a lint rule id, a restricted subject, a script name, a path. */
  readonly identifier: string;
  /** The «Механизм» cell it came from, so a failure names the sentence that has to change. */
  readonly row: string;
}

/** Stable, human-readable key — what the pending registry is keyed on. */
export const claimKey = (check: DeclaredCheck): string =>
  `${check.rule} · ${check.kind} · ${check.identifier}`;

const VERIFICATION_HEADING = '## Как проверяется';

/**
 * The «Механизм» column of the «Как проверяется» table, and nothing else in the rule.
 *
 * The prose of a rule argues; only this table claims. Reading anything else would mean parsing
 * sentences like «`withTenant` открывает транзакцию» as assertions about the world, and every such
 * reading is a false positive waiting to be filed against this test.
 */
export const verificationRows = (markdown: string): string[] => {
  const lines = markdown.split('\n');
  const rows: string[] = [];
  let inside = false;

  for (const line of lines) {
    if (line.startsWith('## ')) {
      inside = line.trim() === VERIFICATION_HEADING;
      continue;
    }
    if (!inside || !line.trimStart().startsWith('|')) continue;

    const cells = line.trim().split('|').slice(1, -1);
    const mechanism = (cells[0] ?? '').trim();

    // The header row and the `|---|` divider are table syntax, not claims.
    if (mechanism === '' || /^-+$/.test(mechanism) || mechanism === 'Механизм') continue;

    rows.push(mechanism);
  }

  return rows;
};

/** ESLint core rules the tables name without a plugin prefix. */
const CORE_ESLINT_RULES = new Set([
  'no-console',
  'no-debugger',
  'no-restricted-imports',
  'no-restricted-syntax',
  'no-restricted-globals',
  'no-restricted-properties',
  'no-restricted-exports',
]);

/** `plugin/rule` or `@scope/plugin/rule` — the only shape a plugin rule id can take. */
const NAMESPACED_RULE = /^(?:@[a-z0-9-]+\/)?[a-z0-9-]+\/[a-z0-9-]+$/;
/** Stylelint has no namespaces: its built-in ids are bare kebab-case. */
const BARE_RULE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/;

/** A rule id may be written with its option attached: `unicorn/filename-case: { … }`. */
const ruleIdOf = (token: string): string => (token.split(/[:\s(]/)[0] ?? '').trim();

/** A `$`-prefixed member, with any call syntax the table wrote around it dropped. */
const DOLLAR_MEMBER = /^(\$[A-Za-z][A-Za-z0-9]*)/;

/**
 * Segments of a cell, alternating plain text and backticked token: `split('`')` puts plain text at
 * even indices and tokens at odd ones.
 */
const segmentsOf = (cell: string): string[] => cell.split('`');

/** Introduces the rule id itself: «ESLint `x`», «Stylelint `x`», «Кастомное ESLint-правило `x`». */
const RULE_LEAD = /(?:ESLint|Stylelint|правило)[\s—-]*$/u;
/**
 * Introduces what the rule is keyed on: «… на `@prisma/client`».
 *
 * Deliberately the bare preposition. «на UI-библиотеки, кроме `@tabler/icons-react`» names an
 * *allowed* package, and «на строковые литералы `localhost`» names an example inside a longer
 * phrase; both stop matching the moment the preposition has to be adjacent.
 *
 * The left boundary is spelled out rather than written as `\b`: JavaScript's word boundary is
 * defined over `[A-Za-z0-9_]`, so it never fires between a space and a Cyrillic letter, and the
 * `\bна` form silently matches nothing at all.
 */
const SUBJECT_LEAD = /(?:^|[\s(])на\s*$/u;
/** Between two tokens of one enumeration: «`a`, `b`», «`a` / `b`», «`a` + `b`». */
const ENUMERATION = /^[\s,;/+]*(?:и|или)?[\s,;/+]*$/u;

const isLintRow = (cell: string): boolean => /ESLint|Stylelint|Кастомное\s+правило/iu.test(cell);
const isStylelintRow = (cell: string): boolean => /Stylelint/iu.test(cell);

/**
 * Lint claims of one cell, by adjacency rather than by keyword search.
 *
 * A token counts only where the sentence puts it in the role: directly after the word that names
 * the linter or the rule, directly after the preposition that introduces the subject, or inside an
 * enumeration continuing one of those. Everything a table says *about* a rule — the layer it
 * applies to, the exception list, the thing it catches — sits behind other words and is skipped.
 */
const lintClaimsOf = (
  rule: string,
  cell: string,
  isDependency: (name: string) => boolean,
): DeclaredCheck[] => {
  if (!isLintRow(cell)) return [];

  const segments = segmentsOf(cell);
  const claims: DeclaredCheck[] = [];
  const bareIdsAllowed = isStylelintRow(cell);
  let role: 'rule' | 'subject' | null = null;

  for (let index = 1; index < segments.length; index += 2) {
    const preceding = segments[index - 1] ?? '';
    const token = segments[index] ?? '';

    if (RULE_LEAD.test(preceding)) role = 'rule';
    else if (SUBJECT_LEAD.test(preceding)) role = 'subject';
    else if (!ENUMERATION.test(preceding)) role = null;

    if (role === 'rule') {
      const identifier = ruleIdOf(token);
      const recognised =
        CORE_ESLINT_RULES.has(identifier) ||
        NAMESPACED_RULE.test(identifier) ||
        (bareIdsAllowed && BARE_RULE.test(identifier));

      if (recognised) claims.push({ rule, kind: 'eslint-rule', identifier, row: cell });
      continue;
    }

    if (role !== 'subject') continue;

    const member = DOLLAR_MEMBER.exec(token);
    if (member !== null) {
      claims.push({ rule, kind: 'eslint-subject', identifier: member[1] as string, row: cell });
      continue;
    }

    // A package the workspace does not install governs code that is not written; the tables use
    // those names for subsystems of later epics, so an uninstalled specifier is not read as a claim.
    if (!/[\s*?]/.test(token) && isDependency(token)) {
      claims.push({ rule, kind: 'eslint-subject', identifier: token, row: cell });
    }
  }

  return claims;
};

/**
 * Package-manager verbs and locally installed binaries, which are not `scripts` of any manifest.
 *
 * Named rather than pattern-matched: the point of the command claim is that `pnpm <name>` resolves
 * to something a contributor can run, and every entry here resolves for a reason of its own.
 */
export const NON_SCRIPT_COMMANDS: Readonly<Record<string, string>> = {
  install: 'a pnpm built-in verb, not a script of any manifest',
  audit: 'a pnpm built-in verb, not a script of any manifest',
  licenses: 'a pnpm built-in verb, not a script of any manifest',
  turbo: 'the turbo binary from the workspace `devDependencies`, invoked directly',
};

/** `pnpm <script>` anywhere inside a backticked span of the cell. */
const PNPM_COMMAND = /`pnpm\s+([a-z][a-z0-9-]*(?::[a-z0-9-]+)*)/g;

const commandClaimsOf = (rule: string, cell: string): DeclaredCheck[] =>
  [...cell.matchAll(PNPM_COMMAND)]
    .map((match) => match[1] as string)
    .filter((name) => NON_SCRIPT_COMMANDS[name] === undefined)
    .map((identifier) => ({ rule, kind: 'command' as const, identifier, row: cell }));

/**
 * A repository path: at least one separator, a source or config extension, no glob metacharacter
 * and no `~`.
 *
 * The exclusions are the boundary, not an optimisation. `use-*-filters.hook.test.ts` is a naming
 * convention rather than a file, and `~/.claude/hooks/git-guard.sh` lives on the contributor's
 * machine — neither is something this repository can be held to.
 */
const REPO_PATH =
  /^[\w.@-]+(?:\/[\w.@-]+)+\.(?:tsx?|[cm]?js|sql|ya?ml|md|mdc|css|json|prisma|sh)$/;

const fileClaimsOf = (rule: string, cell: string): DeclaredCheck[] =>
  [...cell.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1] as string)
    .filter((token) => REPO_PATH.test(token))
    .map((identifier) => ({ rule, kind: 'file' as const, identifier, row: cell }));

/**
 * The three forms a row names a CI gate by: «CI-шаг `x`», «CI-джоб `x`», «grep-чек CI: `x`».
 *
 * All three put the identifier in the same place — the first backticked token of the cell — and
 * that adjacency is the whole discipline. A row that merely mentions CI somewhere in its prose is
 * not naming a step.
 */
const CI_LEAD = /^\s*(?:CI-шаг|CI-джоб|grep-чек\s+CI)/u;
const CI_GREP_LEAD = /^\s*grep-чек\s+CI/u;

/**
 * A bare step or job name: `check:env-parity`, `compose-up-minimal`.
 *
 * Deliberately excludes a command line. «CI-шаг `pnpm install --frozen-lockfile`» quotes a command
 * the `command` claim already resolves; reading it here as well would file the same promise twice
 * under two names, and the second one would be resolved against the wrong namespace. A grep row is
 * exempt because its identifier is a pattern, not a name, and is matched literally.
 */
const CI_NAME = /^[a-z][a-z0-9-]*(?::[a-z0-9-]+)*$/;

const ciStepClaimsOf = (rule: string, cell: string): DeclaredCheck[] => {
  if (!CI_LEAD.test(cell)) return [];

  const identifier = segmentsOf(cell)[1];

  if (identifier === undefined) return [];
  if (!CI_GREP_LEAD.test(cell) && !CI_NAME.test(identifier)) return [];

  return [{ rule, kind: 'ci-step', identifier, row: cell }];
};

/**
 * A test file named without its directory: «Тест `list-matches-can.test.ts`».
 *
 * `REPO_PATH` requires a separator, so every one of these went out unread. The glob metacharacter
 * is excluded by the character class, which is what keeps `*.test.tsx` and `use-*.hook.test.ts` —
 * naming conventions, not files — out of the claims.
 */
const TEST_BASENAME = /^[\w.@-]+\.(?:test|spec)\.tsx?$/;

const testFileClaimsOf = (rule: string, cell: string): DeclaredCheck[] =>
  [...cell.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1] as string)
    .filter((token) => TEST_BASENAME.test(token))
    .map((identifier) => ({ rule, kind: 'test-file' as const, identifier, row: cell }));

/** `@scope/name`, the only shape a scoped package takes — one segment after the scope. */
const SCOPED_PACKAGE = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
/** A bare package: kebab-case with at least one hyphen, no dot and no separator. */
const BARE_PACKAGE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/;

/**
 * Whether a token can be an installed package rather than something that merely looks like one.
 *
 * The `NAMESPACED_RULE` exclusion is the boundary that matters: `import/no-cycle` opens its cell
 * exactly the way `license-checker` opens its own, and only its shape says it is a lint rule id.
 */
const isPackageName = (token: string): boolean =>
  (SCOPED_PACKAGE.test(token) || BARE_PACKAGE.test(token)) && !NAMESPACED_RULE.test(token);

/**
 * A package named as the mechanism itself — `vitest-axe`, `osv-scanner`, `@storybook/addon-a11y`.
 *
 * Position is the entire discipline, for the same reason it is in `lintClaimsOf`: the tables are
 * full of kebab-shaped words that are not packages (`aria-label`, `serious`, `prefers-reduced-motion`),
 * and every one of them sits *inside* a sentence. A package promised as the mechanism opens the
 * cell, or continues an enumeration that did — «`pnpm audit` + `osv-scanner` в CI».
 */
const toolClaimsOf = (rule: string, cell: string): DeclaredCheck[] => {
  const segments = segmentsOf(cell);
  const claims: DeclaredCheck[] = [];

  for (let index = 1; index < segments.length; index += 2) {
    const preceding = segments[index - 1] ?? '';
    const opens = index === 1 ? preceding.trim() === '' : ENUMERATION.test(preceding);

    if (!opens) break;

    const token = segments[index] ?? '';
    if (isPackageName(token)) claims.push({ rule, kind: 'tool', identifier: token, row: cell });
  }

  return claims;
};

/** Every mechanical claim of one rule file. */
export const declaredChecks = (
  rule: string,
  markdown: string,
  isDependency: (name: string) => boolean,
): DeclaredCheck[] =>
  verificationRows(markdown).flatMap((cell) => [
    ...lintClaimsOf(rule, cell, isDependency),
    ...commandClaimsOf(rule, cell),
    ...fileClaimsOf(rule, cell),
    ...ciStepClaimsOf(rule, cell),
    ...testFileClaimsOf(rule, cell),
    ...toolClaimsOf(rule, cell),
  ]);

/**
 * Roots a rule-relative path may be written against.
 *
 * The tables write `test/integration/db/rls-isolation.test.ts` for a file that lives at
 * `packages/server/test/…`, because inside a rule the package is implied by the subject. Resolving
 * against the package roots as well is what makes those rows checkable instead of uniformly red.
 */
const PATH_ROOTS = ['', ...Object.values(PACKAGE_DIRS).map((dir) => `${dir}/`)] as const;

/** Directory listing as an existence probe — listing is not reading, so nothing is recorded. */
const entryExists = (relativePath: string): boolean => {
  const separator = relativePath.lastIndexOf('/');
  const directory = separator === -1 ? '.' : relativePath.slice(0, separator);

  try {
    return repoEntryNames(directory).includes(relativePath.slice(separator + 1));
  } catch {
    return false;
  }
};

const directoryExists = (relativePath: string): boolean => {
  try {
    repoEntryNames(relativePath);
    return true;
  } catch {
    return false;
  }
};

export type ClaimState = 'satisfied' | 'missing' | 'abstained';

/**
 * Three-state, and the third state is the honest half of this test.
 *
 * `satisfied` — the file is there, under the root the rule implies. `missing` — the directory
 * around it is there and the file is not, so the rule points at something a reader would go looking
 * for and not find. `abstained` — no candidate directory exists at all: the subsystem has not been
 * built, the row is a specification for the epic that will build it, and holding it to today's tree
 * would say nothing true.
 */
export const fileClaimState = (identifier: string): ClaimState => {
  const candidates = PATH_ROOTS.map((root) => `${root}${identifier}`);

  if (candidates.some((candidate) => entryExists(candidate))) return 'satisfied';

  const parentOf = (path: string): string => path.slice(0, path.lastIndexOf('/'));

  return candidates.some((candidate) => directoryExists(parentOf(candidate)))
    ? 'missing'
    : 'abstained';
};

/**
 * Every directory a suite of this repository may live in.
 *
 * Not the whole tree: walking a package root descends into its `node_modules`, and the answer would
 * then depend on what happens to be installed. `rules/testing.mdc` §1 closes the list — server and
 * `shared` suites live in `test/**` of their package, the client also co-locates under `src/**`,
 * Playwright scenarios live in `packages/e2e/tests/**`, and the repository harness in `test/**` and
 * `scripts/**`. A runner config accepts nothing else, so a basename absent here is absent.
 */
const TEST_FILE_ROOTS: readonly string[] = [
  'test',
  'scripts',
  ...Object.values(PACKAGE_DIRS).flatMap((dir) => [`${dir}/src`, `${dir}/test`, `${dir}/tests`]),
];

let basenames: Set<string> | null = null;

/** Basenames of every suite file in the tree, walked once. */
const testFileBasenames = (): Set<string> => {
  basenames ??= new Set(
    TEST_FILE_ROOTS.filter((root) => directoryExists(root))
      .flatMap((root) => listRepoFiles(root))
      .map((path) => path.slice(path.lastIndexOf('/') + 1)),
  );

  return basenames;
};

/**
 * Two states, not three, and that is the honest reading here.
 *
 * A path claim abstains when the directory around it does not exist, because the row is then a
 * specification for a subsystem nobody has built. A *basename* carries no directory to abstain on:
 * the rule has named a file and said nothing about where it would live, so the only question the
 * repository can answer is whether a file by that name exists anywhere a runner would look. It does
 * or it does not; a promise that outruns its epic goes in `PENDING` with its reason, in writing.
 */
export const testFileClaimState = (identifier: string): 'satisfied' | 'missing' =>
  testFileBasenames().has(identifier) ? 'satisfied' : 'missing';
