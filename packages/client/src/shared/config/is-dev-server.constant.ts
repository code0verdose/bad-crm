/**
 * Whether this bundle is the one `vite dev` serves.
 *
 * It is deliberately **not** part of `clientEnvSchema`. Everything in that schema is configuration:
 * read from `import.meta.env` at module init, parsed, and looked up at runtime. This is the
 * opposite — a literal the bundler substitutes before Rollup ever sees the file, which is the only
 * form a condition can take if the code it guards is to disappear from the production build rather
 * than merely not run there. Routed through the schema it would become a property read on a parsed
 * object, nothing could be folded, and the devtools would ship to every user.
 *
 * `MODE === 'development'` rather than `DEV`, because `DEV` is also true under Vitest: the suite is
 * not a dev server, and mounting a floating devtools panel into every component test would put a
 * control in the accessibility tree of screens that never have one.
 *
 * The one legitimate reading of `import.meta.env` outside the schema, and it stays inside
 * `shared/config` where ESLint confines the whole family (`rules/security.mdc` rule 3).
 */
export const IS_DEV_SERVER = import.meta.env.MODE === 'development';
