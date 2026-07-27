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
        .filter((specifier) => specifier.startsWith('../'))
        .map((specifier) => `${path} → ${specifier}`),
    );

    expect(relative).toEqual([]);
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
