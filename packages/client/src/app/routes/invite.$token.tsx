/**
 * The page is imported from **its own module**, not from the `@pages` barrel.
 *
 * The barrel re-exports every page, so a route importing it pulls all of them into one shared chunk
 * that the entry then preloads — code-splitting by route, defeated by one import. Measured: the
 * shared `pages-*.js` was 10 kB gzip of screens no first paint reaches, and the budget of
 * `ux-architecture.md` → «Бюджет бандла» is what caught it (STORY-012-03).
 */
import { createFileRoute } from '@tanstack/react-router';

import { AcceptInvitePage } from '@pages/accept-invite';

/**
 * `/invite/$token` — the address in the invitation letter.
 *
 * **A path parameter, not a search parameter**, for the reason `/reset-password/$token` states: a
 * query string is written to the access log of every proxy in front of the installation, travels to
 * the next origin in `Referer`, and is the part of a URL people paste into support tickets
 * (`docs/security/threat-model.md`, T-IAM-07). The token is read from the path here and leaves in
 * the body of `POST /invitations/accept`, so the API never sees it in a URL at all.
 *
 * **No guard, deliberately.** `requireSession` would be absurd on the screen for people who have no
 * account yet, and `redirectIfAuthed` would send away somebody who legitimately holds an invitation
 * to a second organization while signed in to a first.
 *
 * `staticData.crumbKey` is a translation key, which is also why the document title cannot leak the
 * token: the announcer builds it from the crumb, never from the pathname.
 */
export const Route = createFileRoute('/invite/$token')({
  component: AcceptInvitePage,
  staticData: { crumbKey: 'members.accept.title' },
});
