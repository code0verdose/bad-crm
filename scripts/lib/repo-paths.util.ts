import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveToolingEnv, type EnvResolution } from './check-env.util.js';

/** Repository root, derived from this file rather than from the working directory. */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** `true` when the module was started directly by node/tsx rather than imported by a test. */
export const isEntryPoint = (moduleUrl: string): boolean => {
  const invoked = process.argv[1];

  return invoked !== undefined && fileURLToPath(moduleUrl) === resolve(invoked);
};

export const resolveEnvFromDisk = (): EnvResolution =>
  resolveToolingEnv({
    repoRoot,
    processEnv: process.env,
    readFile: (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return undefined;
      }
    },
  });
