import { readFileSync } from 'node:fs';

import { join } from 'node:path';

import { repoRoot } from '../repo-paths.util.js';
import type { CheckOutcome, ServiceCheck } from '../service-check.types.js';

/**
 * The running Node against the one `.nvmrc` pins.
 *
 * Written after a CI failure that could not happen locally. `jsdom@30` raised the required Node to
 * 22.22.2 and `.nvmrc` still said 22.22.1, so the runner — which installs exactly what `.nvmrc`
 * names — refused the whole install. Nobody saw it first, because `nvm use` resolves a bare `22` to
 * the newest 22.x installed: every developer was on 22.22.2 while the file pinned a version none of
 * them was running.
 *
 * That is the failure this check exists for. A patch-level drift is invisible until something in
 * the tree starts caring, and then it appears as "works on my machine" in its purest form.
 *
 * Advisory, not required: refusing to start `pnpm dev` over a patch version would be worse than the
 * problem. The point is that the difference is stated, once, where it is read.
 */
export const createNodeVersionCheck = (runningVersion: string = process.version): ServiceCheck => ({
  service: 'node',
  requirement: 'optional',
  target: `${runningVersion.replace(/^v/, '')} running`,
  run: async (): Promise<CheckOutcome> => {
    const pinned = readFileSync(join(repoRoot, '.nvmrc'), 'utf8').trim();
    const running = runningVersion.replace(/^v/, '');

    if (running === pinned) {
      return { status: 'ok', details: [`matches .nvmrc (${pinned})`] };
    }

    return {
      status: 'failed',
      details: [
        `.nvmrc pins ${pinned}, this shell runs ${running}`,
        'CI installs the pinned version exactly, so a dependency raising its Node floor fails ' +
          'there and not here',
      ],
      remedy: 'nvm install && nvm use',
    };
  },
});
