/**
 * The page is imported from **its own module**, not from the `@pages` barrel.
 *
 * The barrel re-exports every page, so a route importing it pulls all of them into one shared chunk
 * that the entry then preloads — code-splitting by route, defeated by one import. Measured: the
 * shared `pages-*.js` was 10 kB gzip of screens no first paint reaches, and the budget of
 * `ux-architecture.md` → «Бюджет бандла» is what caught it (STORY-012-03).
 */
import { createFileRoute } from '@tanstack/react-router';

import { RegisterPage } from '@pages/register';
import { AuthLib } from '@units/auth';

/**
 * `/register` — public, and outside `_authenticated` for the obvious reason: the account that would
 * satisfy the guard is what this screen creates.
 *
 * `redirectIfAuthed` all the same, and here it does double duty. It keeps a signed-in visitor off a
 * form that would sign them into a *second* organization by accident, and it is the return leg of a
 * successful registration: the mutation records the session and announces it, the router re-checks
 * its guards, and this guard carries the new owner to `POST_LOGIN_PATH`.
 *
 * No search schema: everything this operation needs is typed into the form. Nothing about an
 * organization or an address belongs in a URL that ends up in browser history and proxy logs.
 *
 * Whether the installation accepts new organizations is **not** checked here, and cannot be: nothing
 * public says so before the request is made — see `use-registration.hook.ts`, `isClosed`.
 */
export const Route = createFileRoute('/register')({
  beforeLoad: AuthLib.redirectIfAuthed,
  component: RegisterPage,
  staticData: { crumbKey: 'auth.register.title' },
});
