import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, assert, describe, expect, it, vi } from 'vitest';

import { SharedI18n } from '@shared';

import { axeViolationsIn } from '../support/axe-scan.util.js';
import {
  ALL,
  MEMBER,
  NONE,
  OUTSIDER,
  PEOPLE,
  PROJECT,
  cardReady,
  problem,
  roster,
  rowOf,
  startAt,
  writes,
} from '../support/project-screen.util.js';

/**
 * `/projects/$projectId/members` — the client half of STORY-014-02: who is on the project, and the
 * three roster commands for a reader the card's `permissions.canManageMembers` lets manage it.
 *
 * Mounted as the whole application on the stand the settings suite uses, because what is asserted
 * here is a property of the assembled screen: one signal per action, and **where the focus goes
 * when the control that held it leaves the page** — a row taken off optimistically, a row put back
 * by a rollback as a new node, a form replaced by a sentence. Under `StrictMode`, as the application
 * mounts, since that is what double-attaches every ref these handoffs hang on.
 */

const platformFetch = globalThis.fetch;

afterEach(() => {
  vi.stubGlobal('fetch', platformFetch);
});

/** The names in the roster, top to bottom, header row left out. */
const namesIn = (table: HTMLElement) =>
  within(table)
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getAllByRole('cell')[0]?.textContent);

/** The remove button of the row that names this person — the node on screen right now. */
const removeOf = (table: HTMLElement, name: string): HTMLElement =>
  within(rowOf(table, name)).getByRole('button');

describe('the members section', () => {
  it('is read-only without canManageMembers: no add form, no role select, no remove', async () => {
    await startAt({ section: 'members', flags: { ...ALL, canManageMembers: false } });

    const table = await roster();

    expect(within(table).queryAllByRole('combobox')).toEqual([]);
    expect(within(table).queryAllByRole('button')).toEqual([]);
    expect(screen.queryByRole('button', { name: 'projects.members.add.submit' })).toBeNull();
  });

  it('draws the add form, a role select and a remove button per row with canManageMembers', async () => {
    await startAt({ section: 'members', flags: { ...NONE, canManageMembers: true } });

    const table = await roster();

    expect(within(table).getAllByRole('combobox')).toHaveLength(2);
    expect(
      within(table).getAllByRole('button', { name: 'projects.members.removeOf' }),
    ).toHaveLength(2);
    expect(
      await screen.findByRole('button', { name: 'projects.members.add.submit' }),
    ).toBeDisabled();
  });

  it('offers only people who are not on the project and not the reader', async () => {
    await startAt({ section: 'members' });

    await roster();

    const person = await screen.findByLabelText('projects.members.add.person');

    await waitFor(() => {
      expect(
        within(person)
          .getAllByRole('option')
          .map((option) => option.textContent),
      ).toEqual(['projects.members.add.choose', 'Vera Sidorova']);
    });
  });

  it('adds somebody with the role and share chosen, pessimistically, with one toast', async () => {
    const user = userEvent.setup();

    await startAt({ section: 'members' });

    await roster();
    await user.selectOptions(await screen.findByLabelText('projects.members.add.person'), OUTSIDER);
    await user.selectOptions(screen.getByLabelText('projects.members.add.role'), 'REVIEWER');
    await user.click(screen.getByRole('button', { name: 'projects.members.add.submit' }));

    await waitFor(() => {
      expect(writes('POST')).toHaveLength(1);
    });
    expect(writes('POST')[0]?.body).toEqual({
      userId: OUTSIDER,
      projectRole: 'REVIEWER',
      allocationPct: 100,
    });
    const [added] = writes('POST');

    assert(added !== undefined, 'the add request was not sent');
    expect(added.headers.get('Idempotency-Key')).toMatch(/\S/);
    expect(await screen.findAllByText('projects.members.added')).toHaveLength(1);
  });

  it('changes a role at once, and takes it back — with one toast — when the server refuses', async () => {
    const user = userEvent.setup();
    let answer: (response: Response) => void = () => undefined;

    await startAt({
      section: 'members',
      holdRosterRefetch: true,
      write: () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    });

    const table = await roster();
    const leadRole = within(rowOf(table, 'Anna Ivanova')).getByRole('combobox');

    expect(leadRole).toHaveValue('LEAD');
    await user.selectOptions(leadRole, 'MEMBER');

    // Optimistic: the row says MEMBER before the server has said anything.
    expect(within(rowOf(table, 'Anna Ivanova')).getByRole('combobox')).toHaveValue('MEMBER');
    expect(writes('PATCH')[0]?.body).toEqual({ projectRole: 'MEMBER' });

    answer(problem(409, 'last_project_lead_required'));

    await waitFor(() => {
      expect(within(rowOf(table, 'Anna Ivanova')).getByRole('combobox')).toHaveValue('LEAD');
    });
    expect(await screen.findAllByText('errors.code.last_project_lead_required')).toHaveLength(1);
  });

  it('takes a row off at once, and puts it back in its place when the server refuses', async () => {
    const user = userEvent.setup();
    let answer: (response: Response) => void = () => undefined;

    await startAt({
      section: 'members',
      holdRosterRefetch: true,
      write: () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    });

    const table = await roster();
    const names = () =>
      within(table)
        .getAllByRole('row')
        .slice(1)
        .map((row) => within(row).getAllByRole('cell')[0]?.textContent);

    expect(names()).toEqual(['Anna Ivanova', 'Oleg Petrov']);

    await user.click(within(rowOf(table, 'Anna Ivanova')).getByRole('button'));

    expect(names()).toEqual(['Oleg Petrov']);

    answer(problem(409, 'last_project_lead_required'));

    await waitFor(() => {
      expect(names()).toEqual(['Anna Ivanova', 'Oleg Petrov']);
    });
    expect(await screen.findAllByText('errors.code.last_project_lead_required')).toHaveLength(1);
  });

  it('keeps a removal the server accepted', async () => {
    const user = userEvent.setup();

    await startAt({ section: 'members' });

    const table = await roster();

    await user.click(within(rowOf(table, 'Oleg Petrov')).getByRole('button'));

    expect(await screen.findByText('projects.members.removed')).toBeInTheDocument();
    expect(writes('DELETE').map((call) => call.url)).toEqual([
      `/api/v1/projects/${PROJECT}/members/${MEMBER}`,
    ]);
    expect(within(table).queryByText('Oleg Petrov')).toBeNull();
  });

  it('switches from the overview to the members tab through the tab list', async () => {
    const user = userEvent.setup();

    const { router } = await startAt({ section: '' });

    await cardReady();
    await user.click(screen.getByRole('tab', { name: 'projects.section.members' }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/projects/${PROJECT}/members`);
    });
    expect(screen.getByRole('tab', { name: 'projects.section.members' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });
});

describe('the roster commands — what the server said', () => {
  it('says in one toast why an add was refused, in the words of its reason', async () => {
    const user = userEvent.setup();

    await startAt({
      section: 'members',
      write: () => problem(403, 'user_forbidden', { reason: 'self_assignment_forbidden' }),
    });

    await screen.findByRole('table');
    await user.selectOptions(await screen.findByLabelText('projects.members.add.person'), OUTSIDER);
    await user.click(screen.getByRole('button', { name: 'projects.members.add.submit' }));

    expect(await screen.findAllByText('projects.refusal.selfAssignment')).toHaveLength(1);
    expect(screen.queryByText('errors.code.user_forbidden')).toBeNull();
  });

  it('sends the share of time typed into the form', async () => {
    const user = userEvent.setup();

    await startAt({ section: 'members' });

    await screen.findByRole('table');
    await user.selectOptions(await screen.findByLabelText('projects.members.add.person'), OUTSIDER);

    const share = screen.getByLabelText('projects.members.add.allocation');

    await user.clear(share);
    await user.type(share, '40');
    await user.click(screen.getByRole('button', { name: 'projects.members.add.submit' }));

    await waitFor(() => {
      expect(writes('POST')[0]?.body).toEqual({
        userId: OUTSIDER,
        projectRole: 'MEMBER',
        allocationPct: 40,
      });
    });
  });

  it('says so instead of offering an empty picker when everybody is already on the project', async () => {
    await startAt({ section: 'members', people: PEOPLE.slice(0, 3) });

    expect(await screen.findByText('projects.members.add.none')).toBeInTheDocument();
    expect(screen.queryByLabelText('projects.members.add.person')).toBeNull();
  });

  it('confirms a role change the server accepted', async () => {
    const user = userEvent.setup();

    await startAt({ section: 'members' });

    const table = await screen.findByRole('table');

    await within(table).findByText('Oleg Petrov');
    await user.selectOptions(within(rowOf(table, 'Oleg Petrov')).getByRole('combobox'), 'REVIEWER');

    expect(await screen.findByText('projects.members.updated')).toBeInTheDocument();
    expect(writes('PATCH').map((call) => call.url)).toEqual([
      `/api/v1/projects/${PROJECT}/members/${MEMBER}`,
    ]);
  });
});

describe('the roster, to a screen reader and a keyboard', () => {
  it('has no axe violations with the commands drawn', async () => {
    const { container } = await startAt({ section: 'members' });

    await roster();
    await screen.findByRole('button', { name: 'projects.members.add.submit' });

    expect(await axeViolationsIn(container, { control: 'aria-allowed-attr' })).toEqual([]);
  });

  it('has no axe violations on an archived project', async () => {
    const { container } = await startAt({
      section: 'members',
      overrides: { status: 'ARCHIVED' },
    });

    await roster();

    expect(await axeViolationsIn(container, { control: 'aria-allowed-attr' })).toEqual([]);
  });

  /**
   * An archived project keeps its roster controls on screen (STORY-014-05, acceptance 7), and a
   * keyboard has to be able to reach them: a hard `disabled` drops every select and button out of
   * the tab order, and the only explanation is a banner far above. So each control says
   * «unavailable» itself, says why through the note beside the table — and does nothing, because the
   * code refuses, not the attribute.
   */
  it('keeps the controls of an archived project reachable, explained, and inert', async () => {
    const user = userEvent.setup();

    await startAt({ section: 'members', overrides: { status: 'ARCHIVED' } });

    const table = await roster();
    const role = within(rowOf(table, 'Anna Ivanova')).getByRole('combobox');
    const remove = removeOf(table, 'Anna Ivanova');

    for (const control of [role, remove]) {
      expect(control).not.toBeDisabled();
      expect(control).toHaveAttribute('aria-disabled', 'true');
      control.focus();
      expect(control).toHaveFocus();
    }

    expect(remove).toHaveAccessibleDescription('projects.archived.description');
    // Mantine owns `aria-describedby` on its inputs, so the select is described by its table.
    expect(role.closest('table')).toHaveAccessibleDescription('projects.archived.description');

    await user.selectOptions(role, 'MEMBER');
    remove.focus();
    await user.keyboard('{Enter}');
    await user.click(remove);

    expect(within(rowOf(table, 'Anna Ivanova')).getByRole('combobox')).toHaveValue('LEAD');
    expect(namesIn(table)).toEqual(['Anna Ivanova', 'Oleg Petrov']);
    expect(writes('PATCH')).toEqual([]);
    expect(writes('DELETE')).toEqual([]);
  });

  it('keeps the focus on a role select through its rollback', async () => {
    const user = userEvent.setup();
    let answer: (response: Response) => void = () => undefined;

    await startAt({
      section: 'members',
      holdRosterRefetch: true,
      write: () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    });

    const table = await roster();
    const role = within(rowOf(table, 'Anna Ivanova')).getByRole('combobox');

    role.focus();
    await user.selectOptions(role, 'MEMBER');
    answer(problem(409, 'last_project_lead_required'));

    await waitFor(() => {
      expect(within(rowOf(table, 'Anna Ivanova')).getByRole('combobox')).toHaveValue('LEAD');
    });
    expect(within(rowOf(table, 'Anna Ivanova')).getByRole('combobox')).toHaveFocus();
  });

  it('hands the focus to the next row’s remove button when a row leaves', async () => {
    const user = userEvent.setup();

    await startAt({ section: 'members' });

    const table = await roster();

    removeOf(table, 'Anna Ivanova').focus();
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(namesIn(table)).toEqual(['Oleg Petrov']);
    });
    await waitFor(() => {
      expect(removeOf(table, 'Oleg Petrov')).toHaveFocus();
    });
  });

  it('hands it to the row above when the last row leaves', async () => {
    const user = userEvent.setup();

    await startAt({ section: 'members' });

    const table = await roster();

    removeOf(table, 'Oleg Petrov').focus();
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(namesIn(table)).toEqual(['Anna Ivanova']);
    });
    await waitFor(() => {
      expect(removeOf(table, 'Anna Ivanova')).toHaveFocus();
    });
  });

  it('hands it to the section heading when nobody is left', async () => {
    const user = userEvent.setup();

    await startAt({ section: 'members' });

    const table = await roster();

    removeOf(table, 'Anna Ivanova').focus();
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(removeOf(table, 'Oleg Petrov')).toHaveFocus();
    });
    await user.keyboard('{Enter}');

    expect(await screen.findByText('projects.members.empty')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'projects.members.title' })).toHaveFocus();
    });
  });

  it('gives the focus back to the row a rollback returns', async () => {
    const user = userEvent.setup();
    let answer: (response: Response) => void = () => undefined;

    await startAt({
      section: 'members',
      holdRosterRefetch: true,
      write: () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    });

    const table = await roster();
    const leaving = removeOf(table, 'Anna Ivanova');

    leaving.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(removeOf(table, 'Oleg Petrov')).toHaveFocus();
    });

    answer(problem(409, 'last_project_lead_required'));

    await waitFor(() => {
      expect(namesIn(table)).toEqual(['Anna Ivanova', 'Oleg Petrov']);
    });

    const returned = removeOf(table, 'Anna Ivanova');

    // A new node — which is why the focus has to be put there, not left to stay.
    expect(returned).not.toBe(leaving);
    await waitFor(() => {
      expect(returned).toHaveFocus();
    });
  });

  it('puts the focus on the sentence that replaces the form when the last candidate is added', async () => {
    const user = userEvent.setup();

    await startAt({ section: 'members' });

    await roster();

    const person = await screen.findByLabelText('projects.members.add.person');

    await waitFor(() => {
      expect(within(person).getAllByRole('option')).toHaveLength(2);
    });
    await user.selectOptions(person, OUTSIDER);

    const add = screen.getByRole('button', { name: 'projects.members.add.submit' });

    add.focus();
    await user.keyboard('{Enter}');

    const none = await screen.findByText('projects.members.add.none');

    await waitFor(() => {
      expect(none).toHaveFocus();
    });
  });

  it('does not take the focus to that sentence on arrival', async () => {
    await startAt({ section: 'members', people: PEOPLE.slice(0, 3) });

    const none = await screen.findByText('projects.members.add.none');

    expect(none).not.toHaveFocus();
  });
});

/**
 * The sentences `cimode` cannot state: a role select and a remove button name the person, with the
 * real catalogues — a placeholder left in a label is a key renamed on one side only.
 */
describe.each(['en', 'ru'] as const)('the interpolated labels in %s', (language) => {
  it('name the person a role select and a remove button are about', async () => {
    const i18n = SharedI18n.createI18n(language);

    await startAt({ section: 'members', i18n, language });

    const table = await screen.findByRole('table');
    const select = await within(table).findByRole('combobox', { name: /Oleg Petrov/ });
    const remove = within(table).getByRole('button', { name: /Oleg Petrov/ });

    expect(select.getAttribute('aria-label') ?? '').not.toMatch(/\{\{|projects\./);
    expect(remove.getAttribute('aria-label') ?? '').not.toMatch(/\{\{|projects\./);
  });
});
