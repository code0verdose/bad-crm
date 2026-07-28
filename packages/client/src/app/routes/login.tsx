import { createFileRoute } from '@tanstack/react-router';

import { LoginPage } from '@pages';

import { AuthLib, AuthModel } from '@units/auth';

/**
 * `/login` — outside `_authenticated`, which is the whole reason the layout route is pathless.
 *
 * `validateSearch` takes the Zod schema directly. `@tanstack/zod-adapter` exists for Zod 3 and
 * declares `zod@^3.23.8` as its peer; this workspace is on Zod 4, which the router accepts as a
 * standard-schema validator without an adapter. Adding the adapter would mean two majors of Zod in
 * one bundle to gain nothing.
 */
export const Route = createFileRoute('/login')({
  validateSearch: AuthModel.loginSearchSchema,
  beforeLoad: AuthLib.redirectIfAuthed,
  component: LoginPage,
  staticData: { crumbKey: 'auth.login.title' },
});
