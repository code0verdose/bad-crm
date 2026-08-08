/**
 * The page is imported from **its own module**, not from the `@pages` barrel.
 *
 * The barrel re-exports every page, so a route importing it pulls all of them into one shared chunk
 * that the entry then preloads — code-splitting by route, defeated by one import. Measured: the
 * shared `pages-*.js` was 10 kB gzip of screens no first paint reaches, and the budget of
 * `ux-architecture.md` → «Бюджет бандла» is what caught it (STORY-012-03).
 */
import { createFileRoute } from '@tanstack/react-router';

import { ForgotPasswordPage } from '@pages/forgot-password';
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
