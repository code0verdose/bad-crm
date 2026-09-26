import { describe, expect, it } from 'vitest';

import {
  type AnnouncedPage,
  announcementStep,
  openingPage,
  routePhase,
} from './announcement.util.js';

/**
 * When the route announcer moves focus to the page heading.
 *
 * Two occasions and only two: the page changed (a new name — a new route, or the same route
 * replaced by its error screen), or the page that failed was reloaded. Both are *delivered* only
 * once the page has an answer: while it loads, the heading that will describe it does not exist, and
 * focus moved then lands on the old page's heading or on `<body>`. Everything else — a filter, a page
 * number, a background reload — and the page the tab opened on leave focus where it is.
 */

describe('routePhase', () => {
  it.each([
    ['failed while any match is in error', ['success', 'error'], 'failed'],
    ['loading while any match is pending', ['success', 'pending'], 'loading'],
    ['failed over loading — the error is what the reader sees', ['pending', 'error'], 'failed'],
    ['settled when every match has an answer', ['success', 'notFound', 'redirected'], 'settled'],
    ['settled with no matches at all', [], 'settled'],
    // A match under a not-found one never loads — nothing renders it — and stays pending forever.
    [
      'settled once a not-found match has replaced what is under it',
      ['success', 'notFound', 'pending'],
      'settled',
    ],
    ['loading while a match above the not-found one still is', ['pending', 'notFound'], 'loading'],
  ] as const)('is %s', (_case, statuses, expected) => {
    expect(routePhase(statuses.map((status) => ({ status })))).toBe(expected);
  });
});

describe('announcementStep', () => {
  const page = (
    titleKey: string | undefined,
    { failed = false, owed = false }: { failed?: boolean; owed?: boolean } = {},
  ): AnnouncedPage => ({ titleKey, failed, owed, opening: false });

  it('starts from the page the tab opened on, with nothing owed', () => {
    expect(openingPage('a', 'loading')).toEqual({
      titleKey: 'a',
      failed: false,
      owed: false,
      opening: true,
    });
    expect(openingPage('a', 'failed').failed).toBe(true);
  });

  it('focuses the heading when the page changes and has an answer', () => {
    expect(announcementStep(page('a'), 'b', 'settled')).toEqual({
      focus: true,
      announced: page('b'),
    });
  });

  it('holds the move while the new page loads — its heading is not there yet', () => {
    expect(announcementStep(page('a'), 'b', 'loading')).toEqual({
      focus: false,
      announced: page('b', { owed: true }),
    });
    expect(announcementStep(page('b', { owed: true }), 'b', 'settled')).toEqual({
      focus: true,
      announced: page('b'),
    });
  });

  it('remembers that the new page arrived failed', () => {
    expect(announcementStep(page('a'), 'b', 'failed')).toEqual({
      focus: true,
      announced: page('b', { failed: true }),
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

  it('notes a failure that keeps the page name without moving focus', () => {
    expect(announcementStep(page('a'), 'a', 'failed')).toEqual({
      focus: false,
      announced: page('a', { failed: true }),
    });
  });

  /**
   * A retry of a failed route: the router puts the match back to `pending` for the reload, so the
   * stand-in name goes and the route's own comes back while it loads. Nothing moves then — focus is
   * on the busy «Retry», the one control that can tell the reader how it ends.
   */
  it('keeps focus on the retry through the reload of a failed page', () => {
    expect(announcementStep(page('failed', { failed: true }), 'a', 'loading')).toEqual({
      focus: false,
      announced: page('a', { failed: true, owed: true }),
    });
  });

  it('focuses the heading once the reloaded page settles', () => {
    expect(announcementStep(page('a', { failed: true, owed: true }), 'a', 'settled')).toEqual({
      focus: true,
      announced: page('a'),
    });
    // Even when the reload was never observed as loading.
    expect(announcementStep(page('a', { failed: true }), 'a', 'settled')).toEqual({
      focus: true,
      announced: page('a'),
    });
  });

  /**
   * The reload failed again. The router mounted a new error screen, and the pressed button left
   * with the old one — focus goes to the new screen's heading, not to `<body>`.
   */
  it('focuses the heading when the reloaded page fails again', () => {
    expect(announcementStep(page('a', { failed: true, owed: true }), 'failed', 'failed')).toEqual({
      focus: true,
      announced: page('failed', { failed: true }),
    });
  });

  /**
   * The page the tab opened on keeps focus where the browser put it, whatever it resolves to — the
   * skip link has to be the first Tab (`rules/a11y.mdc` §19). A redirect or a failure on the way in
   * is still the first page, not a navigation.
   */
  it.each(['settled', 'failed'] as const)(
    'leaves focus alone on the page the tab opened on, when it resolves %s',
    (phase) => {
      const step = announcementStep(openingPage('a', 'loading'), 'b', phase);

      expect(step.focus).toBe(false);
      expect(step.announced).toEqual(page('b', { failed: phase === 'failed' }));
    },
  );

  it('waits through the loading of the page the tab opened on', () => {
    expect(announcementStep(openingPage('a', 'loading'), 'b', 'loading')).toEqual({
      focus: false,
      announced: { ...openingPage('b', 'loading'), owed: true },
    });
  });
});
