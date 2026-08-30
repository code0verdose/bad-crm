/**
 * `pnpm i18n:unused` — the filesystem around `i18n-unused.util.ts`.
 *
 * Reads both catalogues under `packages/client/src/shared/i18n/locales`, every non-test source of
 * the client and the shared zod schemas that declare form messages, prints the markdown the
 * workflow would append to a job summary, and exits non-zero when a key is orphaned, asked for
 * without a sentence, or assembled at runtime.
 *
 * The decisions — what counts as usage, why a test file does not, why a schema key with no sentence
 * is reported rather than failed — are in the util beside the code that implements them.
 */
import { readFileSync, readdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  audit,
  isClean,
  renderReport,
  type AuditInput,
  type SourceFile,
} from './i18n-unused.util.js';
import { isEntryPoint, repoRoot } from '../lib/repo-paths.util.js';

const CLIENT_SRC = join(repoRoot, 'packages/client/src');
const LOCALES = join(CLIENT_SRC, 'shared/i18n/locales');
/** Where the client's form messages are declared: a zod `error` there is an i18n key here. */
const SHARED_SCHEMAS = join(repoRoot, 'packages/shared/src/validation');

const sourceFiles = (directory: string): SourceFile[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.tsx?$/.test(entry.name) || entry.name.endsWith('.d.ts')) return [];

    return [{ path: path.slice(repoRoot.length + 1), text: readFileSync(path, 'utf8') }];
  });

/** `{ a: { b: 'c' } }` in `common` → `common.a.b`, the way i18next resolves it. */
const flatten = (value: unknown, prefix: string): string[] => {
  if (typeof value === 'string') return [prefix];
  if (typeof value !== 'object' || value === null) return [];

  return Object.entries(value).flatMap(([key, nested]) => flatten(nested, `${prefix}.${key}`));
};

const namespacesOf = (language: string): string[] =>
  readdirSync(join(LOCALES, language))
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.replace(/\.json$/, ''));

const languages = (): string[] =>
  readdirSync(LOCALES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

/**
 * Both languages merged, not one of them.
 *
 * Parity is somebody else's gate (`catalogue-parity.test.ts`); reading a single reference language
 * here would make this one depend on that one being green, and an orphan present only in `ru` would
 * be invisible on exactly the day parity is broken.
 */
export const readInputs = (): AuditInput => {
  const catalogue = languages().flatMap((language) =>
    namespacesOf(language).flatMap((namespace) =>
      flatten(
        JSON.parse(readFileSync(join(LOCALES, language, `${namespace}.json`), 'utf8')),
        namespace,
      ),
    ),
  );

  return {
    namespaces: [...new Set(languages().flatMap(namespacesOf))],
    catalogue,
    screens: sourceFiles(CLIENT_SRC),
    schemas: sourceFiles(SHARED_SCHEMAS),
  };
};

export const run = (): number => {
  const report = audit(readInputs());
  const markdown = renderReport(report);

  process.stdout.write(`${markdown}\n`);

  const stepSummary = process.env['GITHUB_STEP_SUMMARY'];
  if (stepSummary !== undefined && stepSummary !== '') appendFileSync(stepSummary, `${markdown}\n`);

  return isClean(report) ? 0 : 1;
};

if (isEntryPoint(import.meta.url)) process.exit(run());
