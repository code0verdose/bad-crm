import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerSmoothScroller, scrollToSection } from '@/shared/lib/smooth-scroll.util.js';

/**
 * The registry has exactly one write path (the provider) and one read path (`scrollToSection`), and
 * both are exercised here directly rather than through the components that call them — the retrying,
 * the fallback and the give-up behaviour are properties of this module, not of Lenis or of React.
 */
describe('registerSmoothScroller / scrollToSection', () => {
  afterEach(() => {
    // The registry is module-level state; leaving a scroller registered after a test would silently
    // change the next test's behaviour.
    registerSmoothScroller(null);
    document.body.innerHTML = '';
  });

  it('hands the element straight to the registered scroller, immediately', () => {
    const scrollTo = vi.fn();
    registerSmoothScroller({ scrollTo });

    const section = document.createElement('div');
    section.id = 'pricing';
    document.body.append(section);

    scrollToSection('pricing');

    expect(scrollTo).toHaveBeenCalledWith(section, { immediate: true });
  });

  it('falls back to the native scrollIntoView when no scroller is registered', () => {
    const section = document.createElement('div');
    section.id = 'pricing';
    section.scrollIntoView = vi.fn();
    document.body.append(section);

    scrollToSection('pricing');

    expect(section.scrollIntoView).toHaveBeenCalledOnce();
  });
});

/**
 * The retry loop is timer-driven (`setTimeout`, not `requestAnimationFrame`), and it stops for two
 * different reasons: the element showed up and settled, or the tries ran out. Fake timers make both
 * observable without a real 60ms-per-try wait.
 */
describe('scrollToSection retries for a section that is not mounted yet', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    registerSmoothScroller(null);
    document.body.innerHTML = '';
  });

  it('keeps polling until the element appears, then jumps to it', () => {
    const scrollTo = vi.fn();
    registerSmoothScroller({ scrollTo });

    scrollToSection('late-section');
    expect(scrollTo).not.toHaveBeenCalled();

    // Two retries pass with the element still missing.
    vi.advanceTimersByTime(60);
    vi.advanceTimersByTime(60);
    expect(scrollTo).not.toHaveBeenCalled();

    const section = document.createElement('div');
    section.id = 'late-section';
    document.body.append(section);

    vi.advanceTimersByTime(60);

    expect(scrollTo).toHaveBeenCalledWith(section, { immediate: true });
  });

  it('gives up quietly when the id never appears on the page', () => {
    const scrollTo = vi.fn();
    registerSmoothScroller({ scrollTo });

    scrollToSection('never-exists', 2);

    // Two tries left: two retries run, then the loop stops asking.
    vi.advanceTimersByTime(60);
    vi.advanceTimersByTime(60);
    const pendingAfterBudget = vi.getTimerCount();

    vi.advanceTimersByTime(1000);

    expect(scrollTo).not.toHaveBeenCalled();
    expect(pendingAfterBudget).toBe(0);
  });
});
