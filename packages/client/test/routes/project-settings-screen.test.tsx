import { screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SharedI18n } from '@shared';

import { axeViolationsIn } from '../support/axe-scan.util.js';
import {
  expectFocusInside,
  expectFocusReturnedTo,
  focusEscapes,
  tabWrapFailures,
} from '../support/focus-trap.util.js';
import {
  ALL,
  LEAD,
  MEMBER,
  NONE,
  PEOPLE,
  PROJECT,
  cardReady,
  problem,
  remount,
  sent,
  startAt,
  writes,
} from '../support/project-screen.util.js';

/**
 * `/projects/$projectId/settings` — the client half of STORY-014-01 and of STORY-014-05
 * acceptance 5: **every control is drawn from the card's `permissions` block**, each flag proven in
 * both of its values. The roster and the create page have suites of their own
 * (`project-members-screen.test.tsx`, `project-create-screen.test.tsx`) on the same stand.
 *
 * Mounted as the whole application — real router, real guards, real query client with its global
 * `MutationCache` toast — because «one signal per action» and «focus back on the trigger» are
 * properties of the assembled screen, not of a component on a stand.
 */

const platformFetch = globalThis.fetch;

afterEach(() => {
  vi.stubGlobal('fetch', platformFetch);
});

describe('the settings section — every control from the permissions block', () => {
  it('draws the edit form only for canEdit', async () => {
    await startAt({ flags: { ...NONE, canEdit: true } });
    expect(
      await screen.findByRole('button', { name: 'projects.settings.edit.submit' }),
    ).toBeEnabled();

    await remount({ flags: { ...NONE, canArchive: true } });
    await screen.findByRole('button', { name: 'projects.archive.action' });
    expect(screen.queryByRole('button', { name: 'projects.settings.edit.submit' })).toBeNull();
  });

  it('draws the archive button only for canArchive', async () => {
    await startAt({ flags: { ...NONE, canArchive: true } });
    expect(await screen.findByRole('button', { name: 'projects.archive.action' })).toBeEnabled();

    await remount({ flags: { ...NONE, canDelete: true } });
    await screen.findByRole('button', { name: 'projects.delete.action' });
    expect(screen.queryByRole('button', { name: 'projects.archive.action' })).toBeNull();
  });

  it('draws the delete button only for canDelete', async () => {
    await startAt({ flags: { ...NONE, canDelete: true } });
    expect(await screen.findByRole('button', { name: 'projects.delete.action' })).toBeEnabled();

    await remount({ flags: { ...NONE, canArchive: true } });
    await screen.findByRole('button', { name: 'projects.archive.action' });
    expect(screen.queryByRole('button', { name: 'projects.delete.action' })).toBeNull();
  });

  it('offers the whole directory as the lead only for canManageMembers, the current lead otherwise', async () => {
    await startAt({ flags: { ...NONE, canEdit: true } });

    const locked = await screen.findByLabelText(/projects\.field\.lead/, { selector: 'select' });

    await waitFor(() => {
      expect(
        within(locked)
          .getAllByRole('option')
          .map((option) => option.textContent),
      ).toEqual(['projects.field.leadChoose', 'Anna Ivanova']);
    });

    await remount({ flags: { ...NONE, canEdit: true, canManageMembers: true } });

    const open = await screen.findByLabelText(/projects\.field\.lead/, { selector: 'select' });

    await waitFor(() => {
      expect(within(open).getAllByRole('option')).toHaveLength(PEOPLE.length + 1);
    });
  });

  it('hides the settings tab for a reader the block opens nothing to, and says so on a pasted link', async () => {
    await startAt({ flags: NONE, granted: ['project:read'] });

    expect(await screen.findByText('projects.settings.nothing')).toBeInTheDocument();

    const tabs = within(screen.getByRole('tablist')).getAllByRole('tab');

    expect(tabs.map((tab) => tab.textContent)).not.toContain('projects.section.settings');
  });

  it('does not decide from the role: an admin-like capability set with an all-false block shows nothing', async () => {
    await startAt({
      flags: NONE,
      granted: ['project:read', 'project:update', 'project:archive', 'project:delete'],
    });

    expect(await screen.findByText('projects.settings.nothing')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'projects.archive.action' })).toBeNull();
  });

  /**
   * An archived project keeps its controls on screen (acceptance 7) — and within reach of a
   * keyboard. A hard `disabled` took every field and button out of the tab order, leaving the
   * explanation in a banner at the top of the page: a keyboard user could not find the controls,
   * and a screen reader user heard «dimmed» with no reason. Each control now says «unavailable»
   * itself (`aria-disabled`), is described by a note beside it, and does nothing — the code
   * refuses, not the attribute.
   */
  it('keeps the controls of an archived project reachable, explained, and inert', async () => {
    const user = userEvent.setup();

    await startAt({ overrides: { status: 'ARCHIVED' } });

    const save = await screen.findByRole('button', { name: 'projects.settings.edit.submit' });
    const archive = screen.getByRole('button', { name: 'projects.archive.action' });
    const visibility = screen.getByRole('button', {
      name: /projects\.settings\.visibility\.change/,
    });
    const name = screen.getByLabelText(/projects\.field\.name/);
    const lead = screen.getByLabelText(/projects\.field\.lead/, { selector: 'select' });

    for (const control of [save, archive, visibility, name, lead]) {
      expect(control).not.toBeDisabled();
      expect(control).toHaveAttribute('aria-disabled', 'true');
      control.focus();
      expect(control).toHaveFocus();
    }

    for (const button of [save, archive, visibility]) {
      expect(button).toHaveAccessibleDescription('projects.archived.description');
    }
    // Mantine owns `aria-describedby` on its inputs, so the fields are described by their group.
    expect(name.closest('fieldset')).toHaveAccessibleDescription('projects.archived.description');

    await user.click(archive);
    await user.click(visibility);
    visibility.focus();
    await user.keyboard('{Enter}');
    await user.type(name, ' again');
    await user.selectOptions(lead, MEMBER);
    await user.type(name, '{Enter}');
    save.focus();
    await user.keyboard('{Enter}');
    await user.click(save);

    expect(name).toHaveValue('Bad CRM');
    expect(lead).toHaveValue(LEAD);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(writes('PATCH')).toEqual([]);
    expect(writes('POST')).toEqual([]);
    // The delete stays live: an archive promises nothing *in* the project changes.
    expect(screen.getByRole('button', { name: 'projects.delete.action' })).not.toHaveAttribute(
      'aria-disabled',
    );
  });

  it('has no axe violations on an archived project', async () => {
    const { container } = await startAt({ overrides: { status: 'ARCHIVED' } });

    await screen.findByRole('button', { name: 'projects.settings.edit.submit' });

    expect(await axeViolationsIn(container, { control: 'aria-allowed-attr' })).toEqual([]);
  });

  it('has no axe violations', async () => {
    const { container } = await startAt();

    await screen.findByRole('button', { name: 'projects.settings.edit.submit' });

    expect(await axeViolationsIn(container, { control: 'aria-allowed-attr' })).toEqual([]);
  });
});

describe('editing the project', () => {
  const submit = async (user: UserEvent) => {
    await user.click(await screen.findByRole('button', { name: 'projects.settings.edit.submit' }));
  };

  it('refuses a deadline before the start under the deadline, and sends nothing', async () => {
    const user = userEvent.setup();

    await startAt();

    const due = await screen.findByLabelText('projects.field.dueAt');

    await user.clear(due);
    await user.type(due, '2026-08-01');
    await submit(user);

    await waitFor(() => {
      expect(due).toHaveAttribute('aria-invalid', 'true');
    });
    expect(screen.getByText('projects.field.dueBeforeStart')).toBeInTheDocument();
    expect(writes('PATCH')).toEqual([]);
  });

  it('sends the whole project as a PATCH, dates as UTC instants, and says so once', async () => {
    const user = userEvent.setup();

    await startAt();

    const name = await screen.findByLabelText(/projects\.field\.name/);

    await user.clear(name);
    await user.type(name, '  Better CRM ');
    await submit(user);

    await waitFor(() => {
      expect(writes('PATCH')).toHaveLength(1);
    });
    expect(writes('PATCH')[0]?.body).toEqual({
      name: 'Better CRM',
      description: 'One tool instead of six.',
      leadId: LEAD,
      color: 'brand',
      startedAt: '2026-09-01T00:00:00.000Z',
      dueAt: '2026-12-01T00:00:00.000Z',
    });
    expect(await screen.findByText('projects.saved')).toBeInTheDocument();
  });

  it('puts a server refusal about the lead under the lead, and raises no toast', async () => {
    const user = userEvent.setup();

    await startAt({
      write: () => problem(403, 'user_forbidden', { reason: 'self_assignment_forbidden' }),
    });

    await submit(user);

    const lead = await screen.findByLabelText(/projects\.field\.lead/, { selector: 'select' });

    await waitFor(() => {
      expect(lead).toHaveAttribute('aria-invalid', 'true');
    });
    expect(screen.getAllByText('projects.field.leadSelf')).toHaveLength(1);
    expect(screen.queryByText('errors.code.user_forbidden')).toBeNull();
  });

  it('puts the focus on the first field it refused, in screen order', async () => {
    const user = userEvent.setup();

    await startAt();

    const name = await screen.findByLabelText(/projects\.field\.name/);
    const due = screen.getByLabelText('projects.field.dueAt');

    await user.clear(due);
    await user.type(due, '2026-08-01');
    await user.clear(name);
    await submit(user);

    await waitFor(() => {
      expect(name).toHaveFocus();
    });
    expect(writes('PATCH')).toEqual([]);
  });

  it('puts the focus on the field the server refused', async () => {
    const user = userEvent.setup();

    await startAt({
      write: () => problem(403, 'user_forbidden', { reason: 'self_assignment_forbidden' }),
    });

    await submit(user);

    const lead = await screen.findByLabelText(/projects\.field\.lead/, { selector: 'select' });

    await waitFor(() => {
      expect(lead).toHaveAttribute('aria-invalid', 'true');
    });
    await waitFor(() => {
      expect(lead).toHaveFocus();
    });
  });

  it('puts a 422 issue under its field', async () => {
    const user = userEvent.setup();

    await startAt({
      write: () =>
        problem(422, 'validation_failed', {
          errors: [{ path: 'name', code: 'too_big', message: 'x' }],
        }),
    });

    await submit(user);

    expect(await screen.findByText('errors.field.too_big')).toBeInTheDocument();
    expect(screen.getByLabelText(/projects\.field\.name/)).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('changing the visibility', () => {
  it('confirms first, then sends the change with the confirmation header', async () => {
    const user = userEvent.setup();

    await startAt();

    await user.click(
      await screen.findByRole('button', { name: /projects\.settings\.visibility\.change/ }),
    );

    const dialog = await screen.findByRole('dialog');

    expect(writes('POST')).toEqual([]);
    expect(
      within(dialog).getByText('projects.visibility.close.consequence.access'),
    ).toBeInTheDocument();

    await user.click(
      within(dialog).getByRole('button', { name: 'projects.visibility.close.confirm' }),
    );

    await waitFor(() => {
      expect(writes('POST')).toHaveLength(1);
    });
    expect(writes('POST')[0]?.url).toMatch(/\/visibility$/);
    expect(writes('POST')[0]?.body).toEqual({ visibility: 'PRIVATE' });
    expect(writes('POST')[0]?.headers.get('X-Confirm-Dangerous')).toBe('1');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('is offered by the capability, for want of a flag in the contract', async () => {
    await startAt({ flags: ALL, granted: ['project:read', 'user:read'] });

    await screen.findByRole('button', { name: 'projects.archive.action' });
    expect(
      screen.queryByRole('button', { name: /projects\.settings\.visibility\.change/ }),
    ).toBeNull();
  });
});

describe('archiving the project — the confirmation dialog', () => {
  const openArchive = async (user: UserEvent): Promise<HTMLElement> => {
    await user.click(await screen.findByRole('button', { name: 'projects.archive.action' }));

    return screen.findByRole('dialog');
  };

  it('lists what it does above the button that does it', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = await openArchive(user);
    const consequence = within(dialog).getByText('projects.archive.consequence.readOnly');
    const confirm = within(dialog).getByRole('button', { name: 'projects.archive.confirm' });

    expect(
      consequence.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('opens with the focus on a control that cancels', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = await openArchive(user);

    await waitFor(() => {
      expect(expectFocusInside(dialog)).toHaveAccessibleName('projects.confirm.cancel');
    });
  });

  it('keeps the focus inside itself, in both directions', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = await openArchive(user);

    expect(
      await focusEscapes(user, dialog, await screen.findByLabelText(/projects\.field\.name/)),
    ).toEqual([]);
  });

  it('wraps at both ends rather than swallowing the key', async () => {
    const user = userEvent.setup();

    await startAt();

    expect(await tabWrapFailures(user, await openArchive(user))).toEqual([]);
  });

  it('cancels on Escape without archiving anything, and gives the focus back to the trigger', async () => {
    const user = userEvent.setup();

    await startAt();

    const trigger = await screen.findByRole('button', { name: 'projects.archive.action' });

    await user.click(trigger);
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expectFocusReturnedTo(trigger, 'the archive button');
    });
    expect(writes('POST')).toEqual([]);
  });

  it('shows a refusal inside the dialog in the words of its reason, and no toast', async () => {
    const user = userEvent.setup();

    await startAt({
      write: () => problem(403, 'user_forbidden', { reason: 'insufficient_acl_level' }),
    });

    const dialog = await openArchive(user);

    await user.click(within(dialog).getByRole('button', { name: 'projects.archive.confirm' }));

    const alert = await within(dialog).findByRole('alert');

    expect(alert).toHaveTextContent('projects.refusal.insufficientLevel');
    expect(screen.getAllByText('projects.refusal.insufficientLevel')).toHaveLength(1);
    // The global toast stands aside: it would say the collapsed code, outside the modal.
    expect(screen.queryByText('errors.code.user_forbidden')).toBeNull();
  });

  it('archives on confirm, closes, and says so', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = await openArchive(user);

    await user.click(within(dialog).getByRole('button', { name: 'projects.archive.confirm' }));

    await waitFor(() => {
      expect(writes('POST').map((call) => call.url)).toEqual([
        `/api/v1/projects/${PROJECT}/archive`,
      ]);
    });
    expect(await screen.findByText('projects.archive.done')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });
});

describe('deleting the project', () => {
  it('deletes on confirm and leaves the card, without re-reading the project it just deleted', async () => {
    const user = userEvent.setup();

    const { router } = await startAt();

    await user.click(await screen.findByRole('button', { name: 'projects.delete.action' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'projects.delete.confirm',
      }),
    );

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/projects');
    });
    expect(writes('DELETE').map((call) => call.url)).toEqual([`/api/v1/projects/${PROJECT}`]);

    const deletedAt = sent.findIndex((call) => call.method === 'DELETE');

    expect(
      sent.slice(deletedAt + 1).filter((call) => call.url === `/api/v1/projects/${PROJECT}`),
    ).toEqual([]);
  });
});

describe('the refusals no screen above has shown yet', () => {
  it('opens a private project to the organization, and keeps a refusal inside the dialog', async () => {
    const user = userEvent.setup();

    await startAt({
      overrides: { visibility: 'PRIVATE' },
      write: () => problem(403, 'user_forbidden', { reason: 'insufficient_acl_level' }),
    });

    await user.click(
      await screen.findByRole('button', { name: /projects\.settings\.visibility\.change/ }),
    );

    const dialog = await screen.findByRole('dialog');

    expect(
      within(dialog).getByText('projects.visibility.open.consequence.access'),
    ).toBeInTheDocument();
    await user.click(
      within(dialog).getByRole('button', { name: 'projects.visibility.open.confirm' }),
    );

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'projects.refusal.insufficientLevel',
    );
    expect(writes('POST')[0]?.body).toEqual({ visibility: 'PUBLIC_ORG' });
    expect(screen.queryByText('errors.code.user_forbidden')).toBeNull();
  });

  it('keeps a refused deletion inside the dialog, and stays on the card', async () => {
    const user = userEvent.setup();

    const { router } = await startAt({
      write: () => problem(403, 'user_forbidden', { reason: 'permission_not_granted' }),
    });

    await user.click(await screen.findByRole('button', { name: 'projects.delete.action' }));

    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: 'projects.delete.confirm' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'projects.refusal.permissionNotGranted',
    );
    expect(router.state.location.pathname).toBe(`/projects/${PROJECT}/settings`);
  });

  it('moves between every shipped section through the tab list', async () => {
    const user = userEvent.setup();

    const { router } = await startAt({ section: 'members' });

    await cardReady();
    await user.click(screen.getByRole('tab', { name: 'projects.section.settings' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/projects/${PROJECT}/settings`);
    });

    await user.click(screen.getByRole('tab', { name: 'projects.section.overview' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/projects/${PROJECT}`);
    });
  });
});

/**
 * The sentences `cimode` cannot state: the confirmation names the project and a role select names
 * the person, both with the real catalogues — a placeholder left in a label is a key renamed on one
 * side only.
 */
describe.each(['en', 'ru'] as const)('the interpolated labels in %s', (language) => {
  it('name the project the delete dialog is about', async () => {
    const i18n = SharedI18n.createI18n(language);
    const user = userEvent.setup();

    await startAt({ i18n, language });

    await user.click(await screen.findByRole('button', { name: i18n.t('projects.delete.action') }));

    const dialog = within(await screen.findByRole('dialog'));

    expect(dialog.getByText(/Bad CRM/)).toBeInTheDocument();
    expect(dialog.queryByText(/\{\{/)).toBeNull();
    expect(
      dialog.getAllByRole('button', { name: i18n.t('projects.confirm.cancel') }).length,
    ).toBeGreaterThan(0);
  });
});
