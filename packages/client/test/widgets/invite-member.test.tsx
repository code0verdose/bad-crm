import { MantineProvider } from '@mantine/core';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { InvitationLink } from '@units/iam/ui/invitation-link.component';
import { InviteForm } from '@units/iam/ui/invite-form.component';

import { type IamApi } from '@units/iam';

/**
 * The invite screen's two halves, tested where their rules live.
 *
 * The form owes one decision that is not the server's: «no role for now» is a real choice, so an
 * empty select must submit rather than block. The link panel owes the property the whole screen
 * exists for — **the link is on the screen whether or not a letter went out**, because the server
 * keeps a digest and cannot produce it a second time, and an installation with no relay (NFR-9)
 * must say so instead of looking like it just sent something.
 */

const wrap = (ui: ReactNode) => render(<MantineProvider env="test">{ui}</MantineProvider>);

const minted = (overrides: Partial<IamApi.MintedInvitation> = {}): IamApi.MintedInvitation => ({
  id: '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a81',
  email: 'ivan@example.test',
  inviteUrl: 'https://crm.example.test/invite/opaque-token',
  expiresAt: '2026-08-14T10:00:00.000Z',
  mailDispatched: true,
  ...overrides,
});

describe('the invite form', () => {
  it('submits an address with no role chosen, because that is a real invitation', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    wrap(<InviteForm defaultLocale="ru" isPending={false} onSubmit={onSubmit} roles={[]} />);

    await user.type(screen.getByLabelText(/emailLabel/), 'ivan@example.test');
    await user.click(screen.getByRole('button', { name: /submit/ }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        email: 'ivan@example.test',
        roleId: '',
        // The language the interface is in — the recipient has no account to take one from.
        locale: 'ru',
      });
    });
  });

  it('refuses an address that is not one, without asking the server', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    wrap(<InviteForm defaultLocale="en" isPending={false} onSubmit={onSubmit} roles={[]} />);

    await user.type(screen.getByLabelText(/emailLabel/), 'not-an-address');
    await user.click(screen.getByRole('button', { name: /submit/ }));

    await waitFor(() => {
      expect(onSubmit).not.toHaveBeenCalled();
    });
  });

  it('offers the roles it was given beside the «no role» choice', () => {
    wrap(
      <InviteForm
        defaultLocale="en"
        isPending={false}
        onSubmit={vi.fn()}
        roles={[{ value: 'role-1', label: 'Technical writer' }]}
      />,
    );

    expect(screen.getByRole('option', { name: 'Technical writer' })).toBeInTheDocument();
    // «No role for now» is a choice, not an empty field: an invitation without a role is a normal
    // thing to send.
    expect(screen.getByRole('option', { name: /roleNone/ })).toBeInTheDocument();
  });

  it('carries the pending state on its own button rather than anywhere else', () => {
    wrap(<InviteForm defaultLocale="en" isPending onSubmit={vi.fn()} roles={[]} />);

    expect(screen.getByRole('button', { name: /submit/ })).toHaveAttribute('data-loading', 'true');
  });
});

describe('the link that is shown once', () => {
  it('shows the link and says the letter is on its way', () => {
    wrap(<InvitationLink invitation={minted()} onCopy={vi.fn()} />);

    expect(screen.getByText('https://crm.example.test/invite/opaque-token')).toBeInTheDocument();
    expect(screen.getByText(/invite\.sent/)).toBeInTheDocument();
    expect(screen.queryByText(/invite\.noMail/)).not.toBeInTheDocument();
  });

  it('warns instead when the installation cannot send mail, and still shows the link', () => {
    // NFR-9: no relay is not a failure. The person passes the link on themselves, so it has to be
    // on the screen — and the sentence beside it has to be the other one.
    wrap(<InvitationLink invitation={minted({ mailDispatched: false })} onCopy={vi.fn()} />);

    expect(screen.getByText(/invite\.noMail/)).toBeInTheDocument();
    expect(screen.getByText('https://crm.example.test/invite/opaque-token')).toBeInTheDocument();
    expect(screen.queryByText(/invite\.sent/)).not.toBeInTheDocument();
  });

  it('hands the link back on copy rather than reading it out of the DOM', async () => {
    const user = userEvent.setup();
    const onCopy = vi.fn();

    wrap(<InvitationLink invitation={minted()} onCopy={onCopy} />);

    await user.click(screen.getByRole('button', { name: /copy/ }));

    expect(onCopy).toHaveBeenCalledWith('https://crm.example.test/invite/opaque-token');
  });

  it('announces itself without interrupting, because nothing went wrong', () => {
    wrap(<InvitationLink invitation={minted()} onCopy={vi.fn()} />);

    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});
