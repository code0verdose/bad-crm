import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SharedUi } from '@shared';

/**
 * A relative phrase is friendly and lossy, and this file is about the part that stops it being
 * merely lossy: the machine-readable instant in `dateTime` and the absolute time — **with its
 * zone** — in `title`.
 *
 * «Yesterday» is ambiguous across a team spread over three time zones. The answer to «yesterday for
 * whom» has to be reachable, not just correct somewhere in the data.
 */
const NOW = new Date('2026-07-26T10:00:00Z');

describe('RelativeTime', () => {
  it('says how long ago', () => {
    render(<SharedUi.RelativeTime iso="2026-07-26T09:55:00Z" now={NOW} />);

    expect(screen.getByText('5 minutes ago')).toBeInTheDocument();
  });

  it('is a time element carrying the exact instant', () => {
    render(<SharedUi.RelativeTime iso="2026-07-26T09:55:00Z" now={NOW} />);

    const element = screen.getByText('5 minutes ago');

    expect(element.tagName).toBe('TIME');
    expect(element).toHaveAttribute('datetime', '2026-07-26T09:55:00Z');
  });

  /**
   * The zone is named, but *which* zone is not pinned — the component asks the runtime, and the
   * runtime differs: a CI runner is in UTC and a developer's machine is not. The first version of
   * this case asserted `GMT` and passed locally for exactly that reason, then failed on the runner
   * where the same correct code renders `UTC`.
   *
   * So the assertion is the property: the title carries the absolute time **and** a zone label,
   * whichever one the reader is in. `GMT` covers every offset ICU renders (`GMT+3`), `UTC` covers
   * the zero offset it renders by name.
   */
  it('keeps the absolute time, with its zone, one hover away', () => {
    render(<SharedUi.RelativeTime iso="2026-07-26T09:55:00Z" now={NOW} />);

    const title = screen.getByText('5 minutes ago').getAttribute('title');

    expect(title).toMatch(/\b(GMT|UTC)\b/);
    expect(title).toContain('2026');
  });
});
