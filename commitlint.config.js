// Conventional Commits, enforced by the `commit-msg` hook.
// Contract: CLAUDE.md → «Сообщения коммитов — Conventional Commits, на английском».

/**
 * Canonical scopes: the four workspace packages, the cross-cutting concerns that own their own rule
 * file, and the domain units from `docs/product/glossary.md` (singular, no synonyms — the same name
 * runs through Prisma model, unit folder and API resource).
 */
const SCOPES = [
  // packages
  'shared',
  'server',
  'client',
  'e2e',
  'landing',
  // cross-cutting
  'api',
  // `docs/brain` — the knowledge journal. Three commits used this scope before it was listed, and
  // the enum simply never caught up: the rule of «двойное объяснение» makes a journal entry part of
  // every commit gate, so the scope recurs by construction.
  'brain',
  'auth',
  'ci',
  'config',
  'db',
  'deps',
  'docker',
  'docs',
  'i18n',
  'a11y',
  'lint',
  'outbox',
  'perf',
  'rls',
  'realtime',
  'search',
  'security',
  'test',
  // domain units (docs/product/glossary.md)
  'ai',
  'audit',
  'billing',
  'board',
  'call',
  'chat',
  'collaboration',
  'contract',
  'dashboard',
  'doc',
  'employee',
  'file',
  'github',
  'iam',
  'kb',
  'notification',
  'onboarding',
  'organization',
  'project',
  'saved-view',
  'secure-link',
  'sprint',
  'task',
  'time',
  'timesheet',
  'vault',
];

/**
 * Attribution is authored, not generated: no assistant trailers, no "generated with" footers, no
 * robot emoji. Matching is deliberately narrow — `CLAUDE.md` is a real file in this repository, so
 * `docs(config): document claude.md sections` stays a valid commit message while
 * `chore(lint): let claude write the config` does not.
 */
const AI_ATTRIBUTION = [
  {
    pattern: /co-authored-by:[^\n]*\b(claude|anthropic|copilot|chatgpt|openai|\bai\b)/i,
    hint: 'a Co-Authored-By trailer crediting an assistant',
  },
  { pattern: /generated\s+with\b/i, hint: 'a "generated with …" footer' },
  { pattern: /🤖/u, hint: 'the robot emoji' },
  { pattern: /\bclaude\b(?!\.md)/i, hint: 'a mention of Claude' },
  { pattern: /\banthropic\b/i, hint: 'a mention of Anthropic' },
];

const noAiAttribution = {
  rules: {
    'no-ai-attribution': (parsed) => {
      const raw = String(parsed.raw ?? '');
      const found = AI_ATTRIBUTION.find(({ pattern }) => pattern.test(raw));

      return [
        found === undefined,
        found === undefined
          ? ''
          : `commit message must not contain ${found.hint} — authorship in this repository is plain (CLAUDE.md → «Сообщения коммитов»)`,
      ];
    },
  },
};

export default {
  extends: ['@commitlint/config-conventional'],
  plugins: [noAiAttribution],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'docs',
        'style',
        'refactor',
        'perf',
        'test',
        'build',
        'ci',
        'chore',
        'revert',
      ],
    ],
    'scope-enum': [2, 'always', SCOPES],

    // `scope-case` is deliberately absent, and its absence is the fix for a contradiction rather
    // than a relaxation. commitlint's `kebab-case` rejects digits, so `i18n` and `a11y` — both
    // declared in SCOPES above, both named by rules and epics — could never be written: every commit
    // touching translations or accessibility failed on a rule the enum said nothing about.
    //
    // With a closed `scope-enum` the case rule adds nothing anyway: a scope is either one of the
    // listed strings or it is refused, and the listed strings are how they are spelled.
    'subject-case': [2, 'always', 'lower-case'],
    'subject-empty': [2, 'never'],
    'subject-full-stop': [2, 'never', '.'],
    'subject-max-length': [2, 'always', 50],
    'header-max-length': [2, 'always', 72],
    'body-max-line-length': [2, 'always', 72],
    'no-ai-attribution': [2, 'always'],
  },
};
