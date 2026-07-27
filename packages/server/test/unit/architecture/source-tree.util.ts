import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path of `packages/server/src`. */
const SRC_ROOT = fileURLToPath(new URL('../../../src', import.meta.url));

const walk = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) return walk(path);

    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });

/** Every TypeScript source under `src`, as a path relative to `src` and with `/` separators. */
export const sourceFiles = (): string[] =>
  walk(SRC_ROOT)
    .map((path) => relative(SRC_ROOT, path).split('\\').join('/'))
    .sort();

export const readSource = (file: string): string => readFileSync(join(SRC_ROOT, file), 'utf8');

const IMPORT_SPECIFIER =
  /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * Import specifiers of one source file.
 *
 * A regex rather than the TypeScript compiler API on purpose: the assertions are about strings in
 * `import` statements, the suite must stay in the millisecond range, and a parser here would be a
 * second implementation of module resolution to keep correct.
 */
export const importsOf = (file: string): string[] => {
  const source = readSource(file);
  const specifiers: string[] = [];

  for (const match of source.matchAll(IMPORT_SPECIFIER)) {
    const specifier = match[1] ?? match[2];

    if (specifier !== undefined) specifiers.push(specifier);
  }

  return specifiers;
};
