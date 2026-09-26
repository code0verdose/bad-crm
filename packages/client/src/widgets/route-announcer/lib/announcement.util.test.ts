import { describe, expect, it } from 'vitest';

import { announcementStep, routePhase } from './announcement.util.js';

/**
 * When the route announcer moves focus to the page heading.
 *
 * Two occasions and only two: the page changed (a new crumb), or the page that failed came back
 * after a retry. Everything else — a filter, a page number, a background reload — must leave focus
 * on the control the reader is operating.
 */

describe('routePhase', () => {
  it.each([
    ['failed while any match is in error', ['success', 'error'], 'failed'],
    ['loading while any match is pending', ['success', 'pending'], 'loading'],
    ['failed over loading — the error is what the reader sees', ['pending', 'error'], 'failed'],
    ['settled when every match has an answer', ['success', 'notFound', 'redirected'], 'settled'],
    ['settled with no matches at all', [], 'settled'],
  ] as const)('is %s', (_case, statuses, expected) => {
    expect(routePhase(statuses.map((status) => ({ status })))).toBe(expected);
  });
});

describe('announcementStep', () => {
  const page = (titleKey: string | undefined, failed = false) => ({ titleKey, failed });

  it('focuses the heading when the page changes', () => {
    expect(announcementStep(page('a'), 'b', 'loading')).toEqual({
      focus: true,
      announced: page('b'),
    });
  });

  it('remembers that the new page arrived failed', () => {
    expect(announcementStep(page('a'), 'b', 'failed')).toEqual({
      focus: true,
      announced: page('b', true),
    });
  });

  it('leaves focus alone while the same page is only loading again — a filter, a page number', () => {
    expect(announcementStep(page('a'), 'a', 'loading')).toEqual({
      focus: false,
      announced: page('a'),
    });
    expect(announcementStep(page('a'), 'a', 'settled')).toEqual({
      focus: false,
      announced: page('a'),
    });
  });

  it('notes the failure of the page on screen without moving focus off the retry', () => {
    expect(announcementStep(page('a'), 'a', 'failed')).toEqual({
      focus: false,
      announced: page('a', true),
    });
  });

  it('waits through the reload after a retry — the heading is not there yet', () => {
    expect(announcementStep(page('a', true), 'a', 'loading')).toEqual({
      focus: false,
      announced: page('a', true),
    });
  });

  it('focuses the heading once the failed page settles', () => {
    expect(announcementStep(page('a', true), 'a', 'settled')).toEqual({
      focus: true,
      announced: page('a'),
    });
  });
});
