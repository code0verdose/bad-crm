import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

const stubReducedMotion = (matches: boolean) => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query === REDUCED_MOTION_QUERY ? matches : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
};

/**
 * `lenis` is mocked rather than imported for real: the property under test is whether the provider
 * constructs it at all, and a constructor spy answers that directly without needing a real rAF loop
 * to settle in jsdom.
 */
const lenisConstructor = vi.hoisted(() => vi.fn());
vi.mock('lenis', () => ({
  default: class {
    constructor(...args: unknown[]) {
      lenisConstructor(...args);
    }
    raf = vi.fn();
    destroy = vi.fn();
  },
}));

const { SmoothScrollProvider } = await import('@/app/providers/smooth-scroll.provider.js');

describe('SmoothScrollProvider under prefers-reduced-motion', () => {
  afterEach(() => {
    lenisConstructor.mockClear();
  });

  it('does not construct Lenis when the visitor asked for less motion', () => {
    stubReducedMotion(true);

    render(
      <SmoothScrollProvider>
        <span>content</span>
      </SmoothScrollProvider>,
    );

    expect(screen.getByText('content')).toBeInTheDocument();
    expect(lenisConstructor).not.toHaveBeenCalled();
  });

  it('constructs Lenis when motion is not reduced — the animated path still smooths scroll', () => {
    stubReducedMotion(false);

    render(
      <SmoothScrollProvider>
        <span>content</span>
      </SmoothScrollProvider>,
    );

    expect(lenisConstructor).toHaveBeenCalledOnce();
  });
});
