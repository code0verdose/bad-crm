import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as sharedPublicApi from '../../src/index.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface PackageJson {
  sideEffects?: boolean;
  exports?: Record<string, unknown>;
}

const packageJson = (): PackageJson =>
  JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as PackageJson;

/**
 * Namespace barrels, one per segment carrying runtime values — the only surface server and client
 * are allowed to touch. `types` has no namespace on purpose: branded ids are types, and a
 * namespace over them would be an empty object at runtime.
 */
const NAMESPACES = [
  'SharedValidation',
  'SharedPermissions',
  'SharedErrors',
  'SharedResult',
] as const;

const SUBPATHS = ['.', './validation', './types', './permissions', './errors', './result'];

describe('public API of @bad-crm/shared', () => {
  it.each(NAMESPACES)('exposes the %s namespace', (namespace) => {
    expect(sharedPublicApi).toHaveProperty(namespace);
    expect(Object.keys(sharedPublicApi[namespace]).length).toBeGreaterThan(0);
  });

  it('keeps the package-name smoke export used by server and client wiring', () => {
    expect(sharedPublicApi.SHARED_PACKAGE_NAME).toBe('@bad-crm/shared');
  });

  it('declares a subpath export per segment', () => {
    const exports = packageJson().exports ?? {};

    expect(Object.keys(exports).sort()).toEqual([...SUBPATHS].sort());
  });

  it('is side-effect free, so unused segments are tree-shaken out of the client bundle', () => {
    expect(packageJson().sideEffects).toBe(false);
  });
});
