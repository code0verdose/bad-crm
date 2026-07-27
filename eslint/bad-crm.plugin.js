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

export const badCrmPlugin = {
  meta: { name: 'bad-crm', version: '0.0.0' },
  rules: { 'require-role-suffix': requireRoleSuffix },
};

export default badCrmPlugin;
