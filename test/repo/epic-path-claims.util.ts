/**
 * The one claim a story file makes that this repository can check mechanically.
 *
 * A story is written before the code and edited during it, and the half of it that rots is the task
 * list: a box gets ticked when the work is done, the file it names gets renamed two epics later, and
 * nothing ever compares the two again. Measured on 2026-08-30 in `story-011-01`: three ticked tasks
 * named files that do not exist — `application/platform/jobs/count-deprecated-permission-usage.job.ts`
 * (there is no `jobs` directory at all), `test/architecture/single-permission-catalog.spec.ts` (no
 * such test under any name), and the i18n keys, whose line additionally pointed at `app/i18n/en/`
 * while the locales live in `shared/i18n/locales/`. The prose of that same file, two paragraphs
 * lower, said plainly that two of the three were still open. The tick and the sentence contradicted
 * each other inside one document, and only the sentence was written by somebody re-reading the code.
 *
 * So the rule this reader enforces is deliberately one sentence long, and narrow enough to be true:
 *
 *   **a ticked item (`- [x]`) that names a path in this repository must name a path that exists.**
 *
 * Unticked items are not read at all. `- [ ]` naming a file nobody has written yet is what an
 * unticked item is *for*; gating it would turn a plan into a lie the moment it was written.
 *
 * ## What counts as naming a path
 *
 * Only **inline code** — a token between backticks — on the lines of a ticked item. Not prose, and
 * not fenced blocks (a fence in a story is an example of a command or a diff, not an assertion that
 * a file exists). The measurement that settles this: reading any path-shaped token from anywhere on
 * a ticked line reports **595 findings** over `epics/**`, against **112** for the reader below.
 * Nearly all of that difference is prose citing a module specifier, a rule id or a directory of
 * some other system — and a gate that opens red with 595 entries is deleted in its first week
 * rather than obeyed. `test/rules/declared-checks.util.ts` reads a table cell for the same reason
 * and `test/repo/runbook-claims.util.ts` reads a code span; this is the third genre and the same
 * discipline.
 *
 * A token then has to look like a path in *this* repository, which means it must contain a `/` and
 * either end in a known file extension or open with a known repository root. That leaves out, by
 * shape rather than by exemption list, every route template (`/api/v1/roles`), MIME type
 * (`application/problem+json`), lint rule (`import/no-restricted-paths`), package specifier
 * (`@bad-crm/shared`), docker image (`pgvector/pgvector:pg16`) and shell fragment the corpus writes.
 *
 * ## Placeholder forms, and what is done with each
 *
 * - **Brace alternation** — `locales/{en,ru}/permissions.json` — is **expanded**, and both branches
 *   are claims. It is a shorthand for two literal paths and the item asserts both; not expanding it
 *   would drop precisely the class of defect that started this file, since the i18n line is written
 *   in exactly this form.
 * - **Wildcards** — `packages/landing/**`, `migrations/*_roles/migration.sql` — are **skipped**. A
 *   wildcard names a family, and what the item asserts about a family is that it is non-empty. That
 *   is a weaker claim than «this path exists» and would need its own resolution rules; conflating
 *   the two is how a narrow gate becomes an approximate one.
 * - **Angle placeholders and ellipses** — `@bad-crm/<name>`, `packages/server/src/...`,
 *   `.../ru/permissions.json` — are **skipped**. The author has elided a segment on purpose; the
 *   document is not naming a path there, it is naming the shape of one.
 * - **Module specifiers** — `./errors`, `../../epic-003/...` — are **skipped**. They resolve against
 *   a source file or a document, not against the repository, and the corpus writes them as import
 *   paths rather than as claims about the tree.
 *
 * One consequence is worth stating rather than discovering: inside a ticked item, inline code *is*
 * the assertion form, so a sentence whose whole point is that a path does **not** exist — «the
 * repo-test that guarded this exception was deleted with it», «there is deliberately no
 * `test/integration/auth/` directory» — has to be written as prose. Three items in EPIC-006 were
 * rewritten that way on 2026-08-30. The alternative would be a heuristic for negation in two
 * languages, which is a worse trade than a plain sentence.
 */

import { listRepoFiles, repoEntryNames } from './repo-fixture.util.js';

export interface PathClaim {
  /** Repository-relative path of the story or epic file. */
  readonly file: string;
  /** The path as the reader resolved it — one branch of a brace form, trailing slash removed. */
  readonly path: string;
  /** The code span it came from verbatim, so a failure quotes the line that has to change. */
  readonly span: string;
}

/** Stable, human-readable key — what the pending registry is keyed on. */
export const claimKey = (claim: PathClaim): string => `${claim.file} · ${claim.path}`;

/**
 * Extensions that make a token a file name.
 *
 * A closed list rather than «a dot near the end»: `getmeili/meilisearch:v1.x` and
 * `@commitlint/cli@21` both end in something that pattern-matches an extension, and both are
 * package coordinates. Every entry here is one this corpus actually writes.
 */
const EXTENSION =
  /\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|mdc|ya?ml|sql|css|prisma|sh|txt|html|svg|toml)$/;

/**
 * Directories a path may open with when it carries no extension.
 *
 * These are the roots of this repository, so a token starting with one of them is anchored: it
 * either exists or it is wrong. A token that carries an extension needs no anchor, because the
 * corpus overwhelmingly writes package-relative paths — `application/identity/use-cases/login.use-case.ts`
 * inside a server story — and demanding the anchored form would reject most correct items.
 */
const ROOT = /^(?:packages|docs|test|scripts|epics|rules|\.github|\.claude)\//;

/** Characters that mean «this token is not a bare path»: code, a package coordinate, a URL, a shell line. */
const NOT_A_PATH = /[\s'"()=@:$<>`]/;

/** A fenced block: an example of a command or a diff, never an assertion that a file exists. */
const FENCE = /```[\s\S]*?```/g;

/** The opener of any list item, ticked or not, and of an ordered one. */
const ITEM = /^\s*(?:[-*+]\s|\d+[.)]\s)/;

/** A ticked task item: `- [x]`, at any indentation, in either case. */
const CHECKED = /^\s*[-*+]\s*\[[xX]\]/;

/**
 * The full text of every ticked item, continuation lines included.
 *
 * An item is not a line. The corpus wraps long tasks, and the wrapped half is where the path often
 * ends up — the i18n line of `story-011-01` puts its whole claim on the continuation. An item runs
 * until a blank line, the next list item, or a heading, which is what a markdown reader would do
 * with it.
 */
export const checkedItems = (markdown: string): string[] => {
  const items: string[] = [];
  let current: string[] | null = null;

  for (const line of markdown.replace(FENCE, '').split('\n')) {
    const starts = CHECKED.test(line);

    if (current !== null && (starts || ITEM.test(line) || line.trim() === '' || /^#/.test(line))) {
      items.push(current.join('\n'));
      current = null;
    }

    if (starts) current = [line];
    else if (current !== null) current.push(line);
  }

  if (current !== null) items.push(current.join('\n'));

  return items;
};

/** `{a,b}` alternation, expanded left to right; a token without braces yields itself. */
const expandBraces = (token: string): string[] => {
  const brace = /\{([^{}]*)\}/.exec(token);

  if (brace === null) return [token];

  return (brace[1] ?? '')
    .split(',')
    .flatMap((option) =>
      expandBraces(
        token.slice(0, brace.index) + option + token.slice(brace.index + brace[0].length),
      ),
    );
};

/**
 * Tokens shaped like a file that are not files of this repository.
 *
 * Same bargain as `FOREIGN_*` in `runbook-claims.util.ts`: an exemption is a line somebody reviewed,
 * with the reason attached, rather than a pattern that quietly widens.
 */
export const FOREIGN_PATHS: Readonly<Record<string, string>> = {
  'dist/main.js':
    'the emit of `tsc -b`, not a tracked file: the item asserts that the build produces a runnable ' +
    'entry point, and `dist` is gitignored precisely so that it never becomes a path in the tree',
  'nodemailer/lib/nodemailer.js':
    'a file inside an installed dependency, quoted while explaining which entry point of nodemailer ' +
    'the transport is built from; `node_modules` is not part of this checkout',
};

/** Every path a ticked item of one document names. */
export const pathClaims = (file: string, markdown: string): PathClaim[] =>
  checkedItems(markdown).flatMap((item) =>
    [...item.matchAll(/`([^`\n]+)`/g)].flatMap((match) => {
      const span = match[1] ?? '';
      const token = span.trim();

      if (!token.includes('/')) return [];
      if (NOT_A_PATH.test(token)) return [];
      // Both ellipses: the corpus writes `src/...` in ASCII and `test/integration/auth/…` with the
      // single character, and they mean the same elision.
      if (token.includes('*') || token.includes('...') || token.includes('…')) return [];
      // A leading dot is a module specifier unless it opens one of the dot-directories of the root.
      // `/…` is a URL or an absolute path; `~/…` is the operator's home directory, where the
      // global agent and security files live. Neither is a path in this checkout.
      if (token.startsWith('/') || token.startsWith('~')) return [];
      if (token.startsWith('.') && !ROOT.test(`${token}/`)) return [];

      return expandBraces(token)
        .map((expanded) => expanded.replace(/\/+$/, ''))
        .filter((path) => path.includes('/'))
        .filter((path) => EXTENSION.test(path.split('/').pop() ?? '') || ROOT.test(`${path}/`))
        .filter((path) => FOREIGN_PATHS[path] === undefined)
        .map((path) => ({ file, path, span }));
    }),
  );

/**
 * Directory names never descended into while building the namespace.
 *
 * `worktrees` is the one that matters and the one that is not obvious: `.claude/worktrees/<id>` is a
 * full checkout of this same repository, created and destroyed by parallel agents. Walking it would
 * resolve a renamed path against a copy of the tree rather than against the tree, and the gate would
 * go green or red depending on which agents happened to be running.
 */
const NOT_THE_TREE = new Set([
  'node_modules',
  'dist',
  'coverage',
  'worktrees',
  '.turbo',
  '.git',
  '.vite',
  'test-results',
  'playwright-report',
]);

/** The roots a claimed path can live under — every directory of this repository that holds sources. */
const TREE_ROOTS = ['.github', '.claude', 'docs', 'epics', 'packages', 'rules', 'scripts', 'test'];

/**
 * Every path this checkout contains — files and the directories above them.
 *
 * Directories are in the set because a ticked item legitimately names one (`docs/api/`,
 * `packages/shared/src/ids/`), and a reader that only knew files would call every such item a lie.
 */
export const repoTree = (): Set<string> => {
  const paths = new Set<string>();

  const add = (path: string): void => {
    paths.add(path);

    const parent = path.slice(0, path.lastIndexOf('/'));

    if (parent !== '' && !paths.has(parent)) add(parent);
  };

  for (const root of TREE_ROOTS) {
    for (const path of listRepoFiles(root, (name) => NOT_THE_TREE.has(name))) add(path);
  }

  for (const name of repoEntryNames('.')) paths.add(name);

  return paths;
};

/**
 * Whether the tree contains this path, anchored or package-relative.
 *
 * The second half is what makes the gate readable by the documents it gates. Stories are written
 * from inside a package and name `test/unit/bootstrap/shutdown.test.ts` where the tree says
 * `packages/server/test/unit/bootstrap/shutdown.test.ts`; the suffix has to align on a segment
 * boundary, so `catalog.ts` cannot be satisfied by `permissions.catalog.ts`.
 */
export const resolves = (tree: ReadonlySet<string>, path: string): boolean => {
  if (tree.has(path)) return true;

  for (const known of tree) if (known.endsWith(`/${path}`)) return true;

  return false;
};
