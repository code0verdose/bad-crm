import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sourceRoot = join(packageRoot, 'src');

/** Node-only module specifiers that must never appear in isomorphic code. */
const NODE_ONLY_IMPORT =
  /from\s+['"](node:[^'"]+|fs|path|crypto|os|child_process|worker_threads)['"]/;
/** Browser-only globals that must never appear in isomorphic code. */
const BROWSER_ONLY_GLOBAL = /\b(window|document|localStorage|sessionStorage|navigator)\s*[.[]/;

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));

const offenders = (pattern: RegExp): string[] =>
  sourceFiles(sourceRoot)
    .filter((file) => pattern.test(readFileSync(file, 'utf8')))
    .map((file) => relative(packageRoot, file));

describe('@bad-crm/shared is isomorphic', () => {
  it('has sources to check', () => {
    expect(sourceFiles(sourceRoot).length).toBeGreaterThan(0);
  });

  it('imports no Node-only modules', () => {
    expect(offenders(NODE_ONLY_IMPORT)).toEqual([]);
  });

  it('touches no browser-only globals', () => {
    expect(offenders(BROWSER_ONLY_GLOBAL)).toEqual([]);
  });
});
