import { createFileRoute } from '@tanstack/react-router';

import { ForgotPasswordPage } from '@pages';

import { AuthLib } from '@units/auth';

/**
 * `/forgot-password` — public, and outside `_authenticated` for the obvious reason: the person who
 * needs it cannot sign in.
 *
 * `redirectIfAuthed` all the same (`ux-architecture.md` → «Публичная зона»). Somebody who already
 * has a session does not need a mail to change their password — `/settings/security` does it with
 * the password they know — and a recovery form offered to a signed-in user is an invitation to send
 * a single-use token to a mailbox for no reason.
 *
 * No search schema: the operation takes an address typed into the form and nothing from the URL. A
 * `?email=` parameter would put an address in the browser history and in every proxy log between
 * here and the server.
 */
export const Route = createFileRoute('/forgot-password')({
  beforeLoad: AuthLib.redirectIfAuthed,
  component: ForgotPasswordPage,
  staticData: { crumbKey: 'auth.forgotPassword.title' },
});
