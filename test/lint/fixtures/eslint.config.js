// Re-exports the real root config so `test/lint/architecture-rules.test.ts` asserts against the
// rules that actually ship, not a copy. ESLint resolves `files` globs relative to the directory of
// the config file it loaded, so the root config's `packages/<pkg>/src/**` patterns match this
// fixture tree the same way they match the real packages.
export { default } from '../../../eslint.config.js';
