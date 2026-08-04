import { describe, expect, it } from 'vitest';

import { readJson, readRepoFile } from '../repo/repo-fixture.util.js';

/**
 * Versions this repository refuses to resolve into, and why.
 *
 * On 2026-08-04 a worm published poisoned releases across the `keyv`/`cacheable` namespaces and
 * eight other organisations: a `preinstall` hook that fetches a second stage and harvests cloud,
 * CI and registry credentials. Four of the affected packages are in this tree today — all four as
 * transitive dependencies of ESLint — at versions published *before* the compromise.
 *
 * That is the whole danger. A published version is immutable, so the installed tree is not at
 * risk; what is at risk is the next resolution. Every one of these poisoned releases is a single
 * patch above a version an existing range already accepts, so an unpinned install, a dependabot
 * lockfile refresh or a fresh `pnpm install` walks straight into it. The lockfile alone does not
 * protect: dependabot regenerates it.
 *
 * The quarantine is therefore a floor, not a list of bad hashes: everything at or above the first
 * poisoned version is refused, including releases the maintainer may publish afterwards. That is
 * deliberate and it is the fail-closed direction — a clean 6.0.1 costs one reviewed line to admit,
 * and admitting it should be a decision somebody makes after the namespace is verified, not a
 * default that happens while nobody is looking.
 */
const QUARANTINED = [
  { name: 'keyv', firstPoisoned: '6.0.0' },
  { name: 'cacheable', firstPoisoned: '2.5.1' },
  { name: 'flat-cache', firstPoisoned: '6.1.24' },
  { name: 'file-entry-cache', firstPoisoned: '11.1.6' },
] as const;

const compare = (left: string, right: string): number => {
  const parts = (version: string): number[] => version.split('-')[0]?.split('.').map(Number) ?? [];
  const [a, b] = [parts(left), parts(right)];

  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);

    if (difference !== 0) return difference;
  }

  return 0;
};

/**
 * Every `name@version` the lockfile resolves, read as text rather than through a YAML parser.
 *
 * The interesting keys appear under both `packages:` and `snapshots:` and both forms carry the
 * version in the key, so the question — «what may this lockfile install» — is answered by the keys
 * alone. Peer suffixes (`(@types/node@26.1.1)`) are cut, they are context and not a version.
 */
const resolvedVersions = (name: string): string[] => {
  const escaped = name.replaceAll('/', '\\/').replaceAll('.', '\\.');
  const pattern = new RegExp(String.raw`^ {2}${escaped}@([^\s:(]+)`, 'gm');

  return [...readRepoFile('pnpm-lock.yaml').matchAll(pattern)].flatMap(([, version]) =>
    version === undefined ? [] : [version],
  );
};

const overrides = (): Record<string, string> =>
  readJson<{ pnpm?: { overrides?: Record<string, string> } }>('package.json').pnpm?.overrides ?? {};

describe('packages quarantined after a supply chain compromise', () => {
  it.each(QUARANTINED)(
    '$name is pinned below $firstPoisoned by an override',
    ({ name, firstPoisoned }) => {
      expect(overrides()).toHaveProperty(`${name}@>=${firstPoisoned}`, `<${firstPoisoned}`);
    },
  );

  it.each(QUARANTINED)(
    'the lockfile resolves no $name at or above $firstPoisoned',
    ({ name, firstPoisoned }) => {
      const inside = resolvedVersions(name).filter(
        (version) => compare(version, firstPoisoned) >= 0,
      );

      expect(inside).toEqual([]);
    },
  );

  /**
   * CONTROL: the assertion above is about versions of a package the tree actually has. A rename, a
   * dropped dependency or a regex that stopped matching leaves it passing over an empty list — and
   * a quarantine that guards nothing reads exactly like a quarantine that works.
   *
   * The failure is also the review prompt: a package no longer in the tree does not need an
   * override, and leaving one behind is how this list rots into folklore.
   */
  it.each(QUARANTINED)('CONTROL: $name is really in the tree', ({ name }) => {
    expect(resolvedVersions(name).length).toBeGreaterThan(0);
  });
});
