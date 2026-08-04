/**
 * `pnpm i18n:check` — are both catalogues complete, and how far has each got?
 *
 * Reads `packages/client/src/shared/i18n/locales/<language>/<namespace>.json`, prints the markdown
 * the workflow appends to its job summary, and exits non-zero when a key is unpaired or blank.
 *
 * The set comparisons that run in every test suite live in the client suite
 * (`catalogue-parity.test.ts`, `error-codes-parity.test.ts`); this is the reviewer-facing half plus
 * the one thing they cannot see — a key present in both languages whose value is empty. The logic is
 * in `i18n-summary.util.ts`, tested in `test/ci/i18n-summary.test.ts`; this file is the filesystem
 * around it.
 */
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  flatten,
  isClean,
  renderSummary,
  summarise,
  type CatalogueEntry,
} from './i18n-summary.util.js';
import { isEntryPoint, repoRoot } from '../lib/repo-paths.util.js';

const LOCALES = join(repoRoot, 'packages/client/src/shared/i18n/locales');

const catalogueOf = (language: string): CatalogueEntry[] =>
  readdirSync(join(LOCALES, language))
    .filter((file) => file.endsWith('.json'))
    .flatMap((file) => {
      const namespace = file.replace(/\.json$/, '');
      const tree = JSON.parse(readFileSync(join(LOCALES, language, file), 'utf8')) as Record<
        string,
        unknown
      >;

      return flatten(namespace, tree);
    });

export const run = (): number => {
  const languages = readdirSync(LOCALES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const summary = summarise(
    new Map(languages.map((language) => [language, catalogueOf(language)])),
  );
  const markdown = renderSummary(summary);

  process.stdout.write(`${markdown}\n`);

  const stepSummary = process.env['GITHUB_STEP_SUMMARY'];
  if (stepSummary !== undefined && stepSummary !== '') appendFileSync(stepSummary, `${markdown}\n`);

  return isClean(summary) ? 0 : 1;
};

if (isEntryPoint(import.meta.url)) process.exit(run());
