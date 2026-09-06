import { act, screen, waitFor } from '@testing-library/react';
import { assert, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The grace-period banner — STORY-013-05, acceptance 4.
 *
 * What it has to get right, and why each is a case rather than a glance:
 *
 *   * **it is drawn from the session, not from a request.** `mfaGraceEndsAt` rides on the answer to
 *     `POST /auth/refresh`, so the banner costs nothing and cannot disagree with the gate that
 *     issued it. The field is **absent** for a session no policy covers, so the ordinary case is
 *     «nothing rendered» — and that is asserted with a control, because an empty screen would pass
 *     it for the wrong reason;
 *   * **it cannot be dismissed.** A banner with a close button is a deadline somebody sees once, and
 *     what is on the other side of this one is a session that can do nothing but enrol;
 *   * **the countdown is live.** The phrase is `Intl.RelativeTimeFormat` over a `<time>` element, and
 *     the interval behind it is the one legitimate timer on the screen. A frozen «in 1 day» that
 *     needs a reload to become «in 2 hours» is the defect the tick exists to prevent, so the clock is
 *     moved here and the phrase is expected to move with it;
 *   * **it points at the screen that fixes it**, as a link rather than as a button — a place is
 *     something a keyboard user may open in a new tab.
 */

const USER_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5af1';
const ORGANIZATION_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5af2';

/** The clock every case starts from, so «in six days» is arithmetic rather than a coincidence. */
const NOW = new Date('2026-09-06T12:00:00.000Z');
const GRACE_ENDS_AT = '2026-09-12T12:00:00.000Z';

const platformFetch = globalThis.fetch;

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const startAt = async (graceEndsAt: string | undefined): Promise<void> => {
  vi.resetModules();
  vi.stubGlobal('fetch', async (input: Request) => {
    const { pathname } = new URL(input.url);

    if (pathname.endsWith('/auth/refresh')) {
      return json({
        status: 'authenticated',
        accessToken: 'header.payload.signature',
        tokenType: 'Bearer',
        expiresIn: 900,
        user: { id: USER_ID, email: 'ada@example.test', locale: 'en', timezone: 'UTC' },
        organization: { id: ORGANIZATION_ID, name: 'Bad Company', slug: 'bad-company' },
        // Absent, not `false`/`null`, when the policy covers nobody — the contract states presence.
        ...(graceEndsAt === undefined ? {} : { mfaGraceEndsAt: graceEndsAt }),
      });
    }
    if (pathname.endsWith('/me/permissions')) {
      return json({ permissions: [], denied: [], roles: [], isOwner: false, version: 1 });
    }

    return json({ status: 'ok' });
  });

  const { renderApp } = await import('../support/render-app.util.js');

  renderApp({ path: '/dashboard', status: 'authenticated' });
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.stubGlobal('fetch', platformFetch);
});

describe('the grace-period banner', () => {
  it('is not drawn for a session the policy does not cover', async () => {
    await startAt(undefined);

    // CONTROL: the shell is on screen, so «no banner» is an answer about the banner rather than
    // about a tree that never rendered.
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.queryByText('organization.grace.title')).toBeNull();
  });

  it('names the deadline, in words and in a machine-readable instant', async () => {
    await startAt(GRACE_ENDS_AT);

    expect(await screen.findByText('organization.grace.title')).toBeInTheDocument();

    const instant = document.querySelector('time');

    // Narrowed with `assert`, not with `expect(...).not.toBeNull()`: only the first narrows the
    // type, and reading a field off an optional afterwards is the shape
    // `test/architecture/negated-optional-chain.test.ts` forbids.
    assert(instant !== null, 'the banner renders no <time> element');
    // The `<time>` carries the exact moment: a relative phrase is friendly and lossy, and «in 6
    // days» is ambiguous across a team spread over three time zones.
    expect(instant).toHaveAttribute('datetime', GRACE_ENDS_AT);
    expect(instant.textContent).toContain('6');
  });

  it('offers the way out as a link to the screen that fixes it', async () => {
    await startAt(GRACE_ENDS_AT);

    expect(await screen.findByRole('link', { name: 'organization.grace.action' })).toHaveAttribute(
      'href',
      '/settings/security',
    );
  });

  it('cannot be dismissed, and does not announce itself over and over', async () => {
    await startAt(GRACE_ENDS_AT);

    const banner = (await screen.findByText('organization.grace.title')).closest('[class*=Alert]');

    assert(banner !== null, 'the banner is not rendered as an alert');
    // Mantine renders a dismissal as a button inside the alert; there is to be none.
    expect(banner.querySelectorAll('button')).toHaveLength(0);
    // And no live region around a phrase that changes once a second in the last minute: the shell's
    // route announcer is the only `role="status"` on this screen.
    expect(banner.closest('[role="status"], [aria-live]')).toBeNull();
    expect(banner.querySelector('[role="status"], [role="alert"], [aria-live]')).toBeNull();
  });

  /**
   * The tick, asserted by moving the clock rather than by reading the source.
   *
   * Five days and twenty-three hours in, the phrase is still «in 6 days» because
   * `Intl.RelativeTimeFormat` rounds; one hour later it is not. A banner without the interval keeps
   * the first phrase until somebody reloads the page — which, on the last day of a grace period, is
   * the one time the number matters.
   */
  it('follows the clock instead of freezing on the phrase it opened with', async () => {
    await startAt(GRACE_ENDS_AT);

    await screen.findByText('organization.grace.title');

    const opening = document.querySelector('time');

    assert(opening !== null, 'the banner renders no <time> element');

    const openingPhrase = opening.textContent;

    expect(openingPhrase).toContain('6');

    await act(async () => {
      vi.setSystemTime(new Date('2026-09-12T11:00:00.000Z'));
      await vi.advanceTimersByTimeAsync(1_000);
    });

    // Positive rather than negated, so an element that vanished cannot pass as one that changed:
    // «in 60 minutes» is what an hour before the deadline reads as, and it is not the opening phrase.
    await waitFor(() => {
      expect(opening.textContent).toContain('60');
    });
    expect(opening.textContent).not.toBe(openingPhrase);
  });
});
