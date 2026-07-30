import { MantineProvider } from '@mantine/core';
import { render, screen, within } from '@testing-library/react';
import { type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { SharedUi } from '@shared';

/**
 * The one way a page is divided below its `h1`.
 *
 * The rule it enforces is about the heading tree, not about looks. A screen reader navigates by
 * headings, so a page split with `div`s and styled text is a page with one entry point and no
 * structure — and a page that reaches for `h3` because `h2` "looks too big" is a page with a hole in
 * its outline that no visual review notices. `Section` is what makes «the level is decided by the
 * structure, not by the size» true by construction: it takes no level.
 */
const renderWithProviders = (ui: ReactNode) =>
  render(<MantineProvider env="test">{ui}</MantineProvider>);

describe('Section', () => {
  it('gives its heading level two, under the page title and above nothing', () => {
    renderWithProviders(<SharedUi.Section titleKey="section.members" />);

    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('section.members');
  });

  it('labels the region with its own heading, so it is reachable as a landmark', () => {
    renderWithProviders(<SharedUi.Section titleKey="section.members" />);

    const region = screen.getByRole('region', { name: 'section.members' });

    expect(within(region).getByRole('heading', { level: 2 })).toBeInTheDocument();
  });

  it('renders its content inside the region it labels', () => {
    renderWithProviders(
      <SharedUi.Section titleKey="section.members">
        <p>the roster</p>
      </SharedUi.Section>,
    );

    expect(
      within(screen.getByRole('region', { name: 'section.members' })).getByText('the roster'),
    ).toBeInTheDocument();
  });

  /**
   * The description is optional and, when present, sits between the heading and the content — the
   * reading order a screen reader follows, which is the order it has to make sense in.
   */
  it('places an optional description after the heading and before the content', () => {
    renderWithProviders(
      <SharedUi.Section titleKey="section.members" descriptionKey="section.members.hint">
        <p>the roster</p>
      </SharedUi.Section>,
    );

    const region = screen.getByRole('region', { name: 'section.members' });
    const text = region.textContent ?? '';

    expect(text.indexOf('section.members.hint')).toBeGreaterThan(text.indexOf('section.members'));
    expect(text.indexOf('the roster')).toBeGreaterThan(text.indexOf('section.members.hint'));
  });

  it('omits the description element entirely when there is none', () => {
    renderWithProviders(<SharedUi.Section titleKey="section.members" />);

    expect(screen.getByRole('region', { name: 'section.members' }).textContent).toBe(
      'section.members',
    );
  });

  /**
   * Two sections on one page are two siblings, not a nesting. Asserted because the failure is silent:
   * a second `h2` that accidentally became `h3` reads as «inside the first section» to anybody
   * navigating by headings, and looks identical to everybody else.
   */
  it('keeps sections as siblings when a page has several', () => {
    renderWithProviders(
      <>
        <SharedUi.Section titleKey="section.members" />
        <SharedUi.Section titleKey="section.billing" />
      </>,
    );

    expect(screen.getAllByRole('heading', { level: 2 }).map((node) => node.textContent)).toEqual([
      'section.members',
      'section.billing',
    ]);
    expect(screen.queryByRole('heading', { level: 3 })).not.toBeInTheDocument();
  });

  it('CONTROL: the harness renders a heading at all', () => {
    const { container } = render(<h2>plain</h2>);

    expect(within(container).getByRole('heading', { level: 2 })).toBeInTheDocument();
  });
});
