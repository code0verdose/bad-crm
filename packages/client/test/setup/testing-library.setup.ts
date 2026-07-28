import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

/**
 * One mounted tree per test.
 *
 * Without this, `render` leaves the previous tree in the document and `getByRole` starts matching
 * two elements — a failure that reads as a bug in the component under test rather than as leaked
 * state from the test before it.
 */
afterEach(() => {
  cleanup();
});

/**
 * Two browser APIs jsdom does not implement and Mantine calls on mount.
 *
 * `matchMedia` is how the provider resolves `auto` to a real colour scheme, and `ResizeObserver` is
 * how `ScrollArea` and `AppShell` measure themselves. Without them every render of a Mantine tree
 * throws before a single assertion runs — so these are not test conveniences, they are the parts of
 * the platform the runner is missing.
 *
 * What they must not become is a behaviour stub. `matches` is always `false` — «no media query
 * matched» — which is the honest answer for a headless DOM with no viewport, and it is why a test
 * about a real breakpoint belongs in Playwright rather than here.
 */
vi.stubGlobal(
  'matchMedia',
  vi.fn((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
);

/** The router restores scroll on navigation; jsdom has no viewport to scroll. */
vi.stubGlobal('scrollTo', vi.fn());

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  },
);
