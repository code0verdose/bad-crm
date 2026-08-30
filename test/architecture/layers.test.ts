import { describe, expect, it } from 'vitest';

import {
  applicationSources,
  importsOf,
  layerOf,
  layerOfSpecifier,
  LAYERS,
  segmentOf,
  unitOf,
  unitOfSpecifier,
} from './client-tree.util.js';

/**
 * The direction of every import in `packages/client/src`, checked against the tree that ships.
 *
 * ESLint enforces the same directions and is the faster feedback, but it enforces them per file
 * through `files` globs — a directory the globs stopped matching is silently unguarded, and the
 * fixtures in `test/lint` cannot notice because their paths are invented. This walks the real
 * import graph instead: whatever exists is checked, whether or not a glob remembered it.
 */
const rank = (layer: string): number => LAYERS.indexOf(layer as (typeof LAYERS)[number]);

interface Edge {
  readonly from: string;
  readonly to: string;
  readonly specifier: string;
}

const aliasEdges = (): Edge[] =>
  applicationSources().flatMap((path) => {
    const layer = layerOf(path);
    if (layer === undefined) return [];

    return importsOf(path).flatMap((specifier) => {
      const target = layerOfSpecifier(specifier);
      return target === undefined ? [] : [{ from: path, to: target, specifier }];
    });
  });

/**
 * An import that walks out of its own folder, which the layer aliases exist to make unnecessary.
 *
 * Named for the same reason as `isDeepUnitImport` in `barrels.test.ts`: the assertion built on it
 * compares against an empty list, and a predicate that matches nothing is indistinguishable from a
 * clean tree. Measured: writing the prefix as `'..\\/'` — a shape no specifier has — left the check
 * green. The CONTROL cases feed this function directly, so they die with it.
 */
const isOutwardRelative = (specifier: string): boolean => specifier.startsWith('../');

describe('FSD dependency direction', () => {
  it('finds imports to check, so an empty tree cannot pass this file', () => {
    expect(aliasEdges().length).toBeGreaterThan(0);
  });

  it('never points upwards: app → pages → widgets → units → shared', () => {
    const upwards = aliasEdges()
      .filter((edge) => rank(layerOf(edge.from) as string) > rank(edge.to))
      .map((edge) => `${edge.from} → ${edge.specifier}`);

    expect(upwards).toEqual([]);
  });

  it('keeps units independent of each other', () => {
    const crossUnit = aliasEdges()
      .filter((edge) => {
        const target = unitOfSpecifier(edge.specifier);
        return (
          target !== undefined && unitOf(edge.from) !== undefined && target !== unitOf(edge.from)
        );
      })
      .map((edge) => `${edge.from} → ${edge.specifier}`);

    expect(crossUnit).toEqual([]);
  });

  it('uses the layer aliases, never a relative path out of the current folder', () => {
    const relative = applicationSources().flatMap((path) =>
      importsOf(path)
        .filter(isOutwardRelative)
        .map((specifier) => `${path} → ${specifier}`),
    );

    expect(relative).toEqual([]);
  });

  /** CONTROL: the detector fires on the shape it is looking for — it dies with the predicate. */
  it.each(['../shared/ui', '../../units/auth', '../page.js'])(
    'CONTROL: %s counts as leaving the current folder',
    (specifier) => {
      expect(isOutwardRelative(specifier)).toBe(true);
    },
  );

  /** CONTROL: and not on the forms that are legal, so this is not a ban on relative imports. */
  it.each(['./page.js', './ui/index.js', '@shared/ui', 'react'])(
    'CONTROL: %s does not count as leaving the current folder',
    (specifier) => {
      expect(isOutwardRelative(specifier)).toBe(false);
    },
  );

  /**
   * CONTROL: `importsOf` really does return relative specifiers, so an empty result above means
   * «none point outwards», not «relative imports are invisible to the walk». The alias-edge count
   * cannot say this: it only ever looks at specifiers that start with `@`.
   */
  it('CONTROL: the walk sees relative specifiers, of the inward kind a unit is written with', () => {
    const inward = applicationSources().flatMap((path) =>
      importsOf(path).filter((specifier) => specifier.startsWith('./')),
    );

    expect(inward.length).toBeGreaterThan(0);
  });
});

/**
 * The call chain `ui → service/hooks → service/{queries,mutations} → api` is what keeps a component
 * from knowing about the network. ESLint cannot express it: inside a unit every segment is a legal
 * import, and only the direction between them is wrong.
 */
describe('call chain inside a unit', () => {
  const ALLOWED: Record<string, readonly string[]> = {
    ui: ['model', 'types', 'lib', 'service', 'ui'],
    service: ['model', 'types', 'lib', 'api', 'service'],
    api: ['model', 'types', 'lib', 'api'],
    model: ['model', 'types', 'lib'],
    types: ['model', 'types'],
    lib: ['model', 'types', 'lib'],
  };

  it('never lets a component reach the network layer directly', () => {
    const violations = applicationSources().flatMap((path) => {
      const unit = unitOf(path);
      const segment = segmentOf(path);
      if (unit === undefined || segment === undefined) return [];

      return importsOf(path)
        .filter((specifier) => unitOfSpecifier(specifier) === unit)
        .map((specifier) => specifier.split('/')[2])
        .filter(
          (target): target is string =>
            target !== undefined && !(ALLOWED[segment] ?? []).includes(target),
        )
        .map((target) => `${path} → ${segment} must not import ${target}`);
    });

    expect(violations).toEqual([]);
  });
});
