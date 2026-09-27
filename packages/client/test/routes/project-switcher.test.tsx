import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';

import { axeViolationsIn } from '../support/axe-scan.util.js';
import {
  PROJECT,
  cardReady,
  json,
  remount,
  sent,
  startAt,
  type Call,
} from '../support/project-screen.util.js';

/**
 * The project switcher in the header — STORY-014-06 on the client, mounted as the whole
 * application under `StrictMode` on the project stand, because what is asserted is a property of
 * the assembled shell: the trigger names the project the **path** names, a choice keeps the section
 * the reader is in, focus goes back to the trigger, and what is offered is only what the server
 * answered.
 */

const OTHER = '018f4a3b-2c1d-7a41-9f00-7777777777a2';
const OLD = '018f4a3b-2c1d-7a41-9f00-7777777777a3';

const option = (id: string, key: string, name: string, status = 'ACTIVE') => ({
  id,
  key,
  name,
  status,
  color: 'brand',
});

/** The server of the switcher: the current project is recent, OTHER is on offer, OLD is archived. */
const optionsServer = (call: Call) => {
  const query = new URLSearchParams(call.search);
  const archived = query.get('archived') === 'true';
  const recent = query.getAll('recent');

  return json({
    items: [
      option(OTHER, 'OTH', 'Other project'),
      ...(archived ? [option(OLD, 'OLD', 'Old project', 'ARCHIVED')] : []),
    ],
    hasMore: false,
    recent: recent.includes(PROJECT) ? [option(PROJECT, 'BAD', 'Bad CRM')] : [],
  });
};

const optionReads = (): URLSearchParams[] =>
  sent
    .filter((call) => call.url.endsWith('/projects/options'))
    .map((call) => new URLSearchParams(call.search));

const platformFetch = globalThis.fetch;
const platformScrollIntoView = Element.prototype.scrollIntoView;

/**
 * The combobox scrolls the option the arrows reach into view; jsdom has no layout and does not
 * implement the method. A no-op is the honest stand-in: there is nothing to scroll.
 */
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
});

afterEach(() => {
  vi.stubGlobal('fetch', platformFetch);
  Element.prototype.scrollIntoView = platformScrollIntoView;
  localStorage.clear();
});

const mounted = async () => {
  const app = await startAt({ section: 'members', projectOptions: optionsServer });

  await cardReady();

  const trigger = await screen.findByRole('button', { name: 'nav.projectSwitcher.triggerCurrent' });

  return { ...app, trigger };
};

describe('the project switcher', () => {
  it('names the project of the path and asks nothing until it is opened', async () => {
    const { trigger } = await mounted();

    expect(trigger).toHaveTextContent('BAD');
    expect(trigger).toHaveTextContent('Bad CRM');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(optionReads()).toEqual([]);
  });

  it('opens into the search field, pins the recent project, and offers the rest', async () => {
    const user = userEvent.setup();
    const { trigger } = await mounted();

    await user.click(trigger);

    const search = await screen.findByRole('textbox', { name: 'nav.projectSwitcher.search' });

    await waitFor(() => {
      expect(search).toHaveFocus();
    });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    const recentGroup = await screen.findByText('nav.projectSwitcher.recent');
    // Within the switcher's own list: the roster on the page has role selects of its own.
    const options = await within(screen.getByRole('listbox')).findAllByRole('option');

    expect(recentGroup).toBeInTheDocument();
    expect(options.map((node) => node.textContent)).toEqual([
      expect.stringContaining('Bad CRM'),
      expect.stringContaining('Other project'),
    ]);
    // The guard remembered the visit; the switcher sent the id and the server confirmed it.
    const [first] = optionReads();

    assert(first !== undefined, 'the switcher asked for its options');
    // First — the most recent. Earlier cases of this file may have left their own project behind
    // it: the tab's list outlives a mount, as it outlives a page in the product.
    expect(first.getAll('recent')[0]).toBe(PROJECT);
    expect(first.get('archived')).toBe('false');
    // The count reaches a polite status region — one of several on the page (the route announcer).
    expect(
      screen
        .getAllByRole('status')
        .some((region) => region.textContent === 'nav.projectSwitcher.found'),
    ).toBe(true);
  });

  it('remembers the visits across a reload, through the browser’s storage', async () => {
    const user = userEvent.setup();
    const first = await mounted();
    const firstProject = PROJECT;

    await user.click(first.trigger);
    await screen.findByText('Other project');

    // What the browser keeps is ids and nothing else — no name, no key, no colour.
    const stored: unknown = JSON.parse(localStorage.getItem('bc.recent-projects.v1') ?? 'null');

    assert(Array.isArray(stored), 'opening the switcher wrote the remembered list');
    expect(stored[0]).toBe(firstProject);
    expect(stored.every((value) => typeof value === 'string' && /^[\da-f-]{36}$/.test(value))).toBe(
      true,
    );

    // A reload: a fresh module graph, so this tab's in-memory visits are gone.
    await remount({ section: 'members', projectOptions: optionsServer });
    await cardReady();

    await user.click(
      await screen.findByRole('button', { name: 'nav.projectSwitcher.triggerCurrent' }),
    );
    await screen.findByText('Other project');

    // This visit first, the one before the reload next (anything after them is older cases' leftovers).
    expect(optionReads().at(-1)?.getAll('recent').slice(0, 2)).toEqual([PROJECT, firstProject]);
  });

  it('keeps the section: members of this project become members of the chosen one', async () => {
    const user = userEvent.setup();
    const { trigger, router } = await mounted();

    await user.click(trigger);
    await screen.findByText('Other project');
    await user.keyboard('{ArrowDown}{ArrowDown}');

    const search = screen.getByRole('textbox', { name: 'nav.projectSwitcher.search' });
    const active = search.getAttribute('aria-activedescendant');

    assert(active !== null, 'the field names the option the arrows reached');
    expect(document.getElementById(active)).toHaveTextContent('Other project');

    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/projects/${OTHER}/members`);
    });
  });

  it('closes on Escape and gives the focus back to the trigger', async () => {
    const user = userEvent.setup();
    const { trigger } = await mounted();

    await user.click(trigger);
    await screen.findByRole('textbox', { name: 'nav.projectSwitcher.search' });
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(trigger).toHaveFocus();
    });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens on Ctrl+Alt+P by the physical key, whatever the layout types', async () => {
    const { trigger } = await mounted();

    // `з` is what the P key types on a Russian layout; the code is what the shortcut matches.
    fireEvent.keyDown(document.body, { key: 'з', code: 'KeyP', ctrlKey: true, altKey: true });

    await waitFor(() => {
      expect(trigger).toHaveAttribute('aria-expanded', 'true');
    });
  });

  it('hides the archive until asked, then marks it in words', async () => {
    const user = userEvent.setup();
    const { trigger } = await mounted();

    await user.click(trigger);
    await screen.findByText('Other project');

    expect(screen.queryByText('Old project')).toBeNull();

    await user.click(screen.getByRole('switch', { name: 'nav.projectSwitcher.archived' }));

    const archivedRow = await screen.findByRole('option', { name: /Old project/ });

    expect(within(archivedRow).getByText('nav.projectSwitcher.archivedMark')).toBeInTheDocument();
    expect(optionReads().at(-1)?.get('archived')).toBe('true');
  });

  it('asks once per pause, not once per keystroke', async () => {
    const user = userEvent.setup();
    const { trigger } = await mounted();

    await user.click(trigger);
    await screen.findByText('Other project');
    await user.keyboard('oth');

    await waitFor(() => {
      expect(optionReads().some((read) => read.get('q') === 'oth')).toBe(true);
    });
    // Neither «o» nor «ot» reached the server: the pause swallowed them.
    expect(optionReads().map((read) => read.get('q'))).toEqual([null, 'oth']);
  });

  it('has no axe violations with the list open', async () => {
    const user = userEvent.setup();
    const { trigger } = await mounted();

    await user.click(trigger);
    await screen.findByText('Other project');

    const listbox = screen.getByRole('listbox');
    const dropdown = listbox.parentElement;

    assert(dropdown !== null, 'the list sits inside the dropdown');
    expect(await axeViolationsIn(dropdown, { control: 'label' })).toEqual([]);
  });
});
