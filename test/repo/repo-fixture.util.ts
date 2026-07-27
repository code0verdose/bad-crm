import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseJsonc } from 'jsonc-parser';

/** Absolute path of the repository root, independent of the working directory of the runner. */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const PACKAGE_DIRS = {
  shared: 'packages/shared',
  server: 'packages/server',
  client: 'packages/client',
  e2e: 'packages/e2e',
} as const;

export const PACKAGE_NAMES = {
  shared: '@bad-crm/shared',
  server: '@bad-crm/server',
  client: '@bad-crm/client',
  e2e: '@bad-crm/e2e',
} as const;

/**
 * Reads a JSON(C) file from the repository. Turbo and TypeScript configs allow comments and
 * trailing commas, so a JSONC parser is used instead of `JSON.parse`.
 */
export const readJson = <T>(relativePath: string): T => {
  const raw = readFileSync(join(repoRoot, relativePath), 'utf8');
  const errors: { error: number; offset: number }[] = [];
  const parsed = parseJsonc(raw, errors, { allowTrailingComma: true }) as T;

  if (errors.length > 0) {
    throw new Error(`${relativePath} is not valid JSONC: ${JSON.stringify(errors)}`);
  }

  return parsed;
};
