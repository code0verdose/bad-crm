/**
 * The page is imported from **its own module**, not from the `@pages` barrel.
 *
 * The barrel re-exports every page, so a route importing it pulls all of them into one shared chunk
 * that the entry then preloads — code-splitting by route, defeated by one import. Measured: the
 * shared `pages-*.js` was 10 kB gzip of screens no first paint reaches, and the budget of
 * `ux-architecture.md` → «Бюджет бандла» is what caught it (STORY-012-03).
 */
import { createFileRoute } from '@tanstack/react-router';

import { ResetPasswordPage } from '@pages/reset-password';

/**
 * `/reset-password/$token` — the address in the mail.
 *
 * **A path parameter, not a search parameter, and that is a security decision rather than a routing
 * one.** A query string is written to the access log of every proxy in front of the installation,
 * travels to the next origin in `Referer`, and is the part of a URL people paste into support
 * tickets (`docs/security/threat-model.md`, T-IAM-07). The token is read from the path here and
 * leaves in the body of `POST /auth/reset-password`, so the API never sees it in a URL at all.
 *
 * **No guard, deliberately.** `redirectIfAuthed` would send a signed-in visitor away from a link
 * they legitimately hold — following a reset mail on a second device is exactly that — and
 * `requireSession` would be absurd on the screen for people who cannot sign in. The credential this
 * route runs on is the token, and the server checks it.
 *
 * `staticData.crumbKey` is a translation key, which is also why the document title cannot leak the
 * token: the announcer builds it from the crumb, never from the pathname
 * (`widgets/route-announcer`).
 */
export const Route = createFileRoute('/reset-password/$token')({
  component: ResetPasswordPage,
  staticData: { crumbKey: 'auth.resetPassword.title' },
});
