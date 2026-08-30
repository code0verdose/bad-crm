import { describe, expect, it } from 'vitest';

import { readJson } from '../repo/repo-fixture.util.js';

/**
 * The client declares exactly one UI-kit, and this is what enforces it.
 *
 * [ADR-0006](../../docs/architecture/adr/0006-mantine-css-modules-no-tailwind.md) chose Mantine as
 * the single UI-kit and CSS Modules as the single styling mechanism, and its «Проверяемость»
 * section has asked for this check since 2026-07-26. Until 2026-08-30 nothing ran it.
 *
 * What a second kit costs is not a duplicated button: it is two sets of tokens that drift apart on
 * the first palette change, two dark-theme mechanisms, and a cascade war that shows up as a
 * component styled correctly everywhere except the one screen where both libraries render. None of
 * that is a type error and none of it fails a render test — the manifest is where it is cheap to
 * see, and the manifest is the one place a second kit cannot hide from.
 *
 * Scope is the client package on purpose. `packages/landing` deliberately has no UI-kit at all
 * (its dependencies are `motion`, `lenis`, `ogl`), so the positive control below — «Mantine is
 * really declared» — has nothing to bind to there.
 */
const BANNED_EXACT = ['tailwindcss', 'antd', 'styled-components', '@emotion/styled'] as const;

/** Namespaces where any package is a second kit: `@mui/material`, `@chakra-ui/react`, … */
const BANNED_NAMESPACES = ['@mui/', '@chakra-ui/'] as const;

interface Manifest {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
}

/**
 * Every package name the client manifest declares, in any of the four fields.
 *
 * `devDependencies` counts: Tailwind and Emotion arrive there — a build-time plugin and a styling
 * runtime pulled in by a component library are both «installed», and both change what the bundle
 * renders.
 */
const declaredNames = (): string[] => {
  const manifest = readJson<Manifest>('packages/client/package.json');

  return [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ];
};

const isSecondKit = (name: string): boolean =>
  BANNED_EXACT.some((banned) => banned === name) ||
  BANNED_NAMESPACES.some((namespace) => name.startsWith(namespace));

describe('the second-kit detector', () => {
  it.each([
    ['a namespaced kit', '@mui/material'],
    ['another package of the same namespace', '@mui/x-data-grid'],
    ['Chakra', '@chakra-ui/react'],
    ['a utility-CSS framework', 'tailwindcss'],
    ['a runtime CSS-in-JS styling library', '@emotion/styled'],
  ])('rejects %s', (_case, name) => {
    expect(isSecondKit(name)).toBe(true);
  });

  it.each([
    ['the kit the project chose', '@mantine/core'],
    ['its form package', '@mantine/form'],
    ['the icon set', '@tabler/icons-react'],
    // `@emotion/react` is not `@emotion/styled`: the exact match is what keeps a transitive peer
    // of some future charting package from reading as a styling decision the project never made.
    ['the Emotion runtime without its styled API', '@emotion/react'],
  ])('accepts %s', (_case, name) => {
    expect(isSecondKit(name)).toBe(false);
  });
});

describe('the client manifest', () => {
  it('declares no second UI-kit', () => {
    const offenders = declaredNames().filter(isSecondKit);

    expect(
      offenders,
      'ADR-0006: Mantine is the only UI-kit; styling is CSS Modules, not Tailwind or CSS-in-JS',
    ).toEqual([]);
  });

  /**
   * CONTROL: the assertion above passes over an empty list, and an empty list is exactly what a
   * renamed package directory, a moved manifest or a parser change would produce. A gate that
   * guards nothing reads identically to a gate that works.
   */
  it('CONTROL: really declares Mantine, so the list above is not empty by accident', () => {
    expect(declaredNames()).toContain('@mantine/core');
  });
});
