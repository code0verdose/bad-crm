import { AuthService, AuthUi } from '@units/auth';

/**
 * The composition point of the shell: it asks a unit for state and hands it to that unit's UI.
 *
 * A widget is allowed to call a unit's service hook — that is what separates it from a page, which
 * only arranges widgets. What it must never do is fetch: `useQuery` and `fetch` are banned in this
 * layer by `eslint.config.js`, so the data path stays `ui → service/hooks → service/queries → api`.
 */
export function AppStatus() {
  const session = AuthService.useBootstrapSession();

  return (
    <section>
      <AuthUi.SessionStatusBadge status={session.status} />
    </section>
  );
}
