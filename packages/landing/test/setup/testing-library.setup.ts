import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

/**
 * jsdom implements neither `matchMedia` nor `ResizeObserver`, and this package is built on both:
 * every motion decision on the page asks a media query, and the marquee measures itself.
 *
 * The stub answers "no match" to everything, which is the honest default for a headless DOM — and
 * `use-reduced-motion.hook.ts` reads that as "motion allowed", so a suite exercises the animated
 * path unless it overrides the query itself.
 */
beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );

  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );

  /**
   * `IntersectionObserver` is missing from jsdom too, and it is what every `whileInView` on the
   * page waits for. A stub that never fires would leave the suite asserting against elements that
   * are permanently in their `hidden` variant — so this one reports "in view" as soon as it is
   * asked, which is the state a reader scrolling the page ends up in.
   */
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        this.callback(
          [{ target, isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
      }
      unobserve = vi.fn();
      disconnect = vi.fn();
      takeRecords = vi.fn(() => []);
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // The page persists the language and the colour scheme, and jsdom keeps one `localStorage` for
  // the whole file: without this, a test that switches to Russian leaves the next one rendering in
  // Russian and failing on an English string it never chose.
  localStorage.clear();
});
