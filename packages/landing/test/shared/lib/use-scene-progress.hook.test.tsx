import { render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { useSceneProgress } from '@/shared/lib/use-scene-progress.hook.js';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** A minimal `MediaQueryList` stub, matching only the query this hook actually reads. */
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

const Probe = ({ staticProgress }: { staticProgress?: number }) => {
  const target = useRef<HTMLDivElement>(null);
  const progress = useSceneProgress(target, {
    offset: ['start end', 'end start'],
    ...(staticProgress === undefined ? {} : { staticProgress }),
  });

  return (
    <div ref={target} data-testid="probe">
      {progress.get()}
    </div>
  );
};

/**
 * The global test setup answers every media query with "no match", so every other suite exercises
 * the animated path by default. This one overrides `matchMedia` locally to prove the opposite path
 * actually works — that a scene is frozen, not merely slowed down, when the visitor asked for less
 * motion.
 */
describe('useSceneProgress under prefers-reduced-motion', () => {
  it('freezes at the default static progress (0) instead of tracking scroll', () => {
    stubReducedMotion(true);

    render(<Probe />);

    expect(screen.getByTestId('probe')).toHaveTextContent('0');
  });

  it('freezes at whatever static progress the scene declares, not always 0', () => {
    stubReducedMotion(true);

    render(<Probe staticProgress={1} />);

    expect(screen.getByTestId('probe')).toHaveTextContent('1');
  });

  it('does not freeze when the query does not match — the animated path is untouched', () => {
    stubReducedMotion(false);

    render(<Probe staticProgress={1} />);

    // Unreduced motion tracks live scroll progress, which starts at 0 in a jsdom test with no real
    // scrollable layout — the opposite of the frozen `staticProgress` value above.
    expect(screen.getByTestId('probe')).toHaveTextContent('0');
  });
});
