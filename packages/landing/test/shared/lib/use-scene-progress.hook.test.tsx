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

const Probe = ({
  staticProgress,
  testId = 'probe',
}: {
  staticProgress?: number;
  testId?: string;
}) => {
  const target = useRef<HTMLDivElement>(null);
  const progress = useSceneProgress(target, {
    offset: ['start end', 'end start'],
    ...(staticProgress === undefined ? {} : { staticProgress }),
  });

  return (
    <div ref={target} data-testid={testId}>
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
  /**
   * The default and the declared value are asserted in one case, on purpose.
   *
   * A scene left at the default freezes at `0` — and so, in jsdom, does a scene that never froze at
   * all: there is no layout and nothing scrolls, so the animated path reports `0` too. A case
   * asserting only that number is green whether or not the hook reads `prefers-reduced-motion`, and
   * it was: removing the `reduced` term from the guard left it passing. The declared `1` is the only
   * value the frozen path can produce and the animated one cannot, so it carries the proof, and the
   * default is pinned in the same breath rather than in a case that proves nothing on its own.
   */
  it('freezes at whatever static progress the scene declares, defaulting to 0', () => {
    stubReducedMotion(true);

    render(
      <>
        <Probe testId="default" />
        <Probe testId="declared" staticProgress={1} />
      </>,
    );

    expect(screen.getByTestId('declared')).toHaveTextContent('1');
    expect(screen.getByTestId('default')).toHaveTextContent('0');
  });

  it('does not freeze when the query does not match — the animated path is untouched', () => {
    stubReducedMotion(false);

    render(<Probe staticProgress={1} />);

    // Unreduced motion tracks live scroll progress, which starts at 0 in a jsdom test with no real
    // scrollable layout — the opposite of the frozen `staticProgress` value above.
    expect(screen.getByTestId('probe')).toHaveTextContent('0');
  });
});
