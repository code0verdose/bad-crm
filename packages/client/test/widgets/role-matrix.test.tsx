import { MantineProvider, Table } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { RoleMatrixCell } from '@widgets/role-matrix/ui/role-matrix-cell.component';
import { RoleMatrixDraftBar } from '@widgets/role-matrix/ui/role-matrix-draft-bar.component';
import { RoleMatrixPreviewModal } from '@widgets/role-matrix/ui/role-matrix-preview-modal.component';
import { groupPermissions } from '@widgets/role-matrix/lib/group-permissions.util';

import { type IamApi } from '@units/iam';

/**
 * The parts of the matrix screen that carry a rule, tested where the rule lives.
 *
 * The widget as a whole needs a router, a query client and a server; these four do not, and the
 * properties worth pinning are theirs: a cell that cannot be edited says why, a draft bar counts
 * roles, a summary refuses to offer a save that cannot succeed, and «only differences» compares the
 * draft rather than the last fetch.
 */

const wrap = (ui: ReactNode) => render(<MantineProvider env="test">{ui}</MantineProvider>);

const inRow = (ui: ReactNode): ReactNode => (
  <Table>
    <Table.Tbody>
      <Table.Tr>
        <Table.Td>{ui}</Table.Td>
      </Table.Tr>
    </Table.Tbody>
  </Table>
);

const outcome = (overrides: Partial<IamApi.RoleChangeOutcome> = {}): IamApi.RoleChangeOutcome => ({
  roleId: 'role-1',
  key: 'tech_writer',
  name: 'Technical writer',
  isSystem: false,
  holderCount: 3,
  added: ['task:update'],
  removed: [],
  dangerous: [],
  reason: null,
  ...overrides,
});

describe('a cell of the matrix', () => {
  it('is a two-state control, because a role cannot deny', () => {
    // The third state lives on the personal-exceptions screen; offering it here would suggest a
    // role can take a right away, which it cannot (`permission-model.md` §12, divergence 3).
    const onToggle = vi.fn();

    wrap(
      inRow(
        <RoleMatrixCell
          roleName="Technical writer"
          permission="task:read"
          granted
          locked={false}
          onToggle={onToggle}
        />,
      ),
    );

    const cell = screen.getByRole('checkbox');

    expect(cell).toBeChecked();
    expect(cell).toBeEnabled();
  });

  it('cannot be edited on a system role, and says why', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();

    wrap(
      inRow(
        <RoleMatrixCell
          roleName="Manager"
          permission="task:read"
          granted
          locked
          onToggle={onToggle}
        />,
      ),
    );

    expect(screen.getByRole('checkbox')).toBeDisabled();

    // A control that refuses and explains nothing reads as a bug — the reason is not guessable from
    // a grey box.
    await user.hover(screen.getByRole('checkbox').parentElement as HTMLElement);
    expect(await screen.findByText('roles.cell.systemLocked')).toBeInTheDocument();
    expect(onToggle).not.toHaveBeenCalled();
  });
});

describe('the draft bar', () => {
  it('stays out of the way while nothing is unsaved', () => {
    wrap(
      <RoleMatrixDraftBar
        changeCount={0}
        isSaving={false}
        onReview={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );

    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('counts roles and offers the review before the save', async () => {
    const user = userEvent.setup();
    const onReview = vi.fn();

    wrap(
      <RoleMatrixDraftBar
        changeCount={3}
        isSaving={false}
        onReview={onReview}
        onDiscard={vi.fn()}
      />,
    );

    expect(screen.getByRole('region', { name: 'roles.draft.region' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'roles.draft.review' }));

    expect(onReview).toHaveBeenCalledTimes(1);
  });
});

describe('the summary before a save', () => {
  it('refuses to offer a save the server would reject', async () => {
    // The endpoint applies all of it or none, so «save anyway» would offer something that cannot
    // happen — and the refusal is named rather than described.
    const onConfirm = vi.fn();

    wrap(
      <RoleMatrixPreviewModal
        opened
        outcomes={[outcome(), outcome({ roleId: 'role-2', reason: 'system_role_immutable' })]}
        isSaving={false}
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'roles.preview.confirm' })).toBeDisabled();
    expect(await screen.findByText(/roles.refusal.systemRole/)).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('warns before a dangerous key is stored, and still allows it', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();

    wrap(
      <RoleMatrixPreviewModal
        opened
        outcomes={[outcome({ added: ['user:impersonate'], dangerous: ['user:impersonate'] })]}
        isSaving={false}
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('roles.preview.dangerousBody')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'roles.preview.confirm' }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('has no accessibility violations', async () => {
    const { container } = wrap(
      <RoleMatrixPreviewModal
        opened
        outcomes={[outcome()]}
        isSaving={false}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const { violations } = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    });

    expect(violations.map((violation) => violation.id)).toEqual([]);
  });
});

describe('a refusal the client does not recognise', () => {
  it('still says something rather than rendering a code', () => {
    // The server's vocabulary of refusals grows; a client that mapped only the three it knows would
    // one day render `role_frozen_by_billing` at a person.
    wrap(
      <RoleMatrixPreviewModal
        opened
        outcomes={[outcome({ reason: 'a_reason_from_a_later_release' })]}
        isSaving={false}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText(/roles.refusal.unknown/)).toBeInTheDocument();
  });
});

describe('«only differences»', () => {
  const roles = [
    { id: 'role-1', isSystem: false },
    { id: 'role-2', isSystem: false },
  ] as IamApi.RoleListEntry[];

  it('compares the draft, not the last fetch', () => {
    // The filter exists to read what distinguishes the roles **right now**, including a distinction
    // the person has just introduced; answering from the server would hide their own work.
    const agreeing = groupPermissions({
      roles,
      search: 'task:read',
      onlyDifferences: true,
      grants: () => true,
    });

    expect(agreeing).toEqual([]);

    const disagreeing = groupPermissions({
      roles,
      search: 'task:read',
      onlyDifferences: true,
      grants: (roleId) => roleId === 'role-1',
    });

    expect(disagreeing.flatMap((group) => group.permissions)).toContain('task:read');
  });

  it('groups what it keeps by domain, and drops empty groups', () => {
    const groups = groupPermissions({
      roles,
      search: 'task:',
      onlyDifferences: false,
      grants: () => false,
    });

    expect(groups.map((group) => group.domain)).toEqual(['task']);
    expect(groups[0]?.permissions.every((key) => key.startsWith('task:'))).toBe(true);
  });
});
