import { describe, expect, it } from 'vitest';

import { createNodeVersionCheck } from '../../scripts/lib/checks/node-version.check.js';
import { readRepoFile } from './repo-fixture.util.js';

/**
 * Written after CI refused an install that every developer machine had accepted. `jsdom@30` raised
 * the Node floor to 22.22.2 while `.nvmrc` still pinned 22.22.1 — and nobody noticed, because
 * `nvm use` resolves a bare `22` to the newest 22.x installed. The pinned version was one nobody
 * was running, so the drift could only surface on the runner, which installs it literally.
 */
describe('the running Node is compared with the pinned one', () => {
  const pinned = (): string => readRepoFile('.nvmrc').trim();

  it('passes when the versions match', async () => {
    const result = await createNodeVersionCheck(`v${pinned()}`).run();

    expect(result.status).toBe('ok');
  });

  it('reports a patch-level drift, which is the one that hides', async () => {
    const result = await createNodeVersionCheck('v22.22.1').run();

    expect(result.status).toBe(pinned() === '22.22.1' ? 'ok' : 'failed');
  });

  it('names both versions, so the message is actionable without a second command', async () => {
    const result = await createNodeVersionCheck('v20.0.0').run();

    expect(result.status).toBe('failed');
    expect(result.details.join(' ')).toContain(pinned());
    expect(result.details.join(' ')).toContain('20.0.0');
    expect(result.remedy).toBeDefined();
  });

  /** Advisory on purpose: a patch mismatch must not stop `pnpm dev`. */
  it('is optional, so it cannot block the dev command', () => {
    expect(createNodeVersionCheck().requirement).toBe('optional');
  });
});
