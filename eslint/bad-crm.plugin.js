/**
 * Local ESLint rules that no published plugin covers. Source of truth for the conventions they
 * encode: `rules/naming-and-structure.mdc`.
 */

/**
 * Closed dictionary of role suffixes, copied from the tables in `rules/naming-and-structure.mdc`.
 * A new suffix is introduced by editing that rule file *and* this list — never ad hoc in a folder.
 */
const ROLE_SUFFIXES = new Set([
  // Frontend
  'component',
  'widget',
  'hook',
  'query',
  'mutation',
  'store',
  'api',
  'types',
  'schema',
  'enums',
  'constant',
  'util',
  'errors',
  'config',
  'client',
  'context',
  'provider',
  'guard',
  'module', // `*.module.css`
  // Backend
  'entity',
  'value',
  'policy',
  'port',
  'use-case',
  'adapter',
  'repository',
  'controller',
  'middleware',
  'routes',
  // Composition: a function that assembles something out of dependencies and returns it —
  // `createHttpServer`, `buildContainer`, `createShutdownHandler`. Added by STORY-003-01; the
  // dictionary in rules/naming-and-structure.mdc carries the same row.
  'factory',
  'validator',
  'serializer',
  'handler',
  // Tests
  'test',
  'spec',
]);

/** Framework-fixed names that carry their role in the name itself (rule 3 of the naming rule). */
const FIXED_NAMES = new Set([
  'index',
  'main',
  'page',
  'layout',
  'providers',
  'router',
  'global',
  'vite-env',
  // Playwright resolves `globalSetup` by path, and the name is its vocabulary for «runs once,
  // before everything» — the same category as `main` and `providers`. Renaming it to satisfy the
  // suffix dictionary would hide what the file is from everyone who knows the tool.
  'global-setup',
]);

/** Generated artefacts are explicitly exempt (see "Исключения" in the naming rule). */
const GENERATED = /\.gen\.[a-z]+$|^api-schema\.d\.ts$/;

const requireRoleSuffix = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Every source file is named `<kebab-description>.<role>.<ext>` with a role from the closed dictionary.',
    },
    schema: [],
    messages: {
      missing:
        '`{{filename}}` has no role suffix. Name source files `<kebab-description>.<role>.<ext>` — see rules/naming-and-structure.mdc for the closed suffix dictionary.',
      unknown:
        '`{{filename}}` uses the unknown role suffix `.{{suffix}}.`. Pick one from the closed dictionary in rules/naming-and-structure.mdc, or extend that rule file first.',
    },
  },
  create(context) {
    return {
      Program(node) {
        const filename = context.filename.split('/').pop() ?? '';

        if (filename.endsWith('.d.ts') || GENERATED.test(filename)) return;

        const segments = filename.split('.');
        const stem = segments[0] ?? '';

        // `overview-page.tsx`, `banner-page.tsx` — sub-pages inside one page folder.
        if (FIXED_NAMES.has(stem) || stem.endsWith('-page')) return;

        if (segments.length < 3) {
          context.report({ node, messageId: 'missing', data: { filename } });
          return;
        }

        const suffix = segments[segments.length - 2] ?? '';

        if (!ROLE_SUFFIXES.has(suffix)) {
          context.report({ node, messageId: 'unknown', data: { filename, suffix } });
        }
      },
    };
  },
};

/** `@units/<unit>/<anything>` — the specifier shapes that reach past a unit's barrel. */
const UNIT_INTERNALS = /^@units\/([^/]+)\/.+/;

/** `packages/client/src/units/<unit>/…` — the unit a file belongs to, if any. */
const OWN_UNIT = /packages\/client\/src\/units\/([^/]+)\//;

/**
 * A unit's internals belong to that unit — and to that unit only.
 *
 * A plain `no-restricted-imports` ban on a `@units` subpath cannot express this, because ESLint matches
 * the specifier without knowing where the file sits. Applied to units as well, it forbids a unit
 * from importing its own segments: `ui` cannot reach the hook next door, and the architecture the
 * ban defends becomes unwritable — which is exactly what happened here until the first real unit
 * existed to try it on. Applied only to consumers, it lets one unit reach into another.
 *
 * So the comparison is between the importing file and the specifier: same unit, allowed; any other
 * unit — or any file outside `units/` — has the barrel and nothing else.
 */
const noForeignUnitInternals = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "A unit's segments are importable from inside that unit only; others use its barrel.",
    },
    schema: [],
    messages: {
      foreign:
        'Import the barrel of `{{unit}}` (`import {{{namespace}}} from "@units/{{unit}}"`), not a path inside it. A unit exposes exactly one public surface (rules/frontend-fsd.mdc, rule 3).',
    },
  },
  create(context) {
    const importingUnit = OWN_UNIT.exec(context.filename.replaceAll('\\', '/'))?.[1];

    const check = (node, value) => {
      const target = UNIT_INTERNALS.exec(value)?.[1];

      if (target === undefined || target === importingUnit) return;

      context.report({
        node,
        messageId: 'foreign',
        data: {
          unit: target,
          namespace: `${target.charAt(0).toUpperCase()}${target.slice(1)}Service`,
        },
      });
    };

    return {
      ImportDeclaration(node) {
        check(node, node.source.value);
      },
      ExportNamedDeclaration(node) {
        if (node.source) check(node, node.source.value);
      },
      ExportAllDeclaration(node) {
        if (node.source) check(node, node.source.value);
      },
    };
  },
};

/** `setSomething(...)` — the shape of a state update, which is what derived state is written with. */
const STATE_SETTER = /^set[A-Z]/;

/**
 * `useEffect` is a synchronisation primitive for the world outside React, and nothing else.
 *
 * Two failures, neither of which the runtime reports. The first is derived state: an effect whose
 * body only calls setters renders twice for every change and is stale in between, where computing
 * the value during render is always correct. The second is an effect with no explanation — the
 * habit that lets the first kind be added beside it without anyone noticing.
 *
 * The rule therefore asks for one of two things: don't use an effect, or say why this one is a
 * real side effect. `rules/frontend-fsd.mdc` rule 11 is the norm being enforced.
 */
const noEffectForDerivedState = {
  meta: {
    type: 'problem',
    docs: { description: 'useEffect is for real side effects, and each one carries its reason.' },
    schema: [],
    messages: {
      derived:
        'This effect only assigns state derived from its dependencies. Compute the value during render (or with `useMemo`), reset it with a `key`, or do the work in the event handler — see rules/frontend-fsd.mdc, rule 11.',
      unexplained:
        'Say why this effect is a real side effect with the outside world (subscription, imperative DOM, timer) in a comment above it, and give it a cleanup. Data belongs to TanStack Query, derived state to render — rules/frontend-fsd.mdc, rule 11.',
    },
  },
  create(context) {
    const { sourceCode } = context;

    const isStateSetter = (statement) =>
      statement.type === 'ExpressionStatement' &&
      statement.expression.type === 'CallExpression' &&
      statement.expression.callee.type === 'Identifier' &&
      STATE_SETTER.test(statement.expression.callee.name);

    /**
     * A comment that is an explanation rather than a marker.
     *
     * `// TODO`, `// FIXME`, `// eslint-disable-next-line …` and a bare `//` are not reasons — and
     * before this check any of them satisfied the rule.
     */
    const hasExplanation = (comments) =>
      comments.some((comment) => {
        const text = comment.value.trim();

        return text.length >= 20 && !/^(TODO|FIXME|HACK|XXX|eslint-|@ts-)/i.test(text);
      });

    // Both spellings, and `useLayoutEffect` too. Measured: `React.useEffect(...)` slipped past a
    // selector keyed on `callee.name` — the callee is a MemberExpression there, and the rule simply
    // never ran. A rule that silently does not run is worse than an absent one: the line in the
    // "how it is checked" table says it is covered.
    return {
      ['CallExpression[callee.name=/^use(Layout)?Effect$/],' +
        'CallExpression[callee.property.name=/^use(Layout)?Effect$/]'](node) {
        const [callback] = node.arguments;
        const body =
          callback !== undefined &&
          (callback.type === 'ArrowFunctionExpression' || callback.type === 'FunctionExpression') &&
          callback.body.type === 'BlockStatement'
            ? callback.body.body
            : [];

        if (body.length > 0 && body.every((statement) => isStateSetter(statement))) {
          context.report({ node, messageId: 'derived' });
          return;
        }

        // The reason may be written above the call, above the statement it belongs to, or inside
        // the callback next to the line that needs it — all three are the same explanation.
        const explained =
          // The location stays permissive — above the call or inside the callback are both natural,
          // and the rule's own message asks for a sentence, not a position. What is no longer
          // accepted is the *content*: a stray `// TODO` anywhere in the body used to satisfy the
          // rule, measured. A kept effect carries a written reason; a marker is not a reason.
          hasExplanation(sourceCode.getCommentsBefore(node)) ||
          (node.parent !== undefined &&
            hasExplanation(sourceCode.getCommentsBefore(node.parent))) ||
          (callback !== undefined && hasExplanation(sourceCode.getCommentsInside(callback)));

        if (!explained) context.report({ node, messageId: 'unexplained' });
      },
    };
  },
};

export const badCrmPlugin = {
  meta: { name: 'bad-crm', version: '0.0.0' },
  rules: {
    'require-role-suffix': requireRoleSuffix,
    'no-foreign-unit-internals': noForeignUnitInternals,
    'no-effect-for-derived-state': noEffectForDerivedState,
  },
};

export default badCrmPlugin;
