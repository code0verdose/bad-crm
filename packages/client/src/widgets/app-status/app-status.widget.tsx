import { SessionService, SessionUi } from '@units/session';

/**
 * The composition point of the shell: it asks a unit for state and hands it to that unit's UI.
 *
 * A widget is allowed to call a unit's service hook — that is what separates it from a page, which
 * only arranges widgets. What it must never do is fetch: `useQuery` and `fetch` are banned in this
 * layer by `eslint.config.js`, so the data path stays `ui → service/hooks → service/queries → api`.
 *
 * STORY-004-07 grows the sidebar, the top bar and the breadcrumbs here.
 */
export function AppStatus() {
  const session = SessionService.useSessionStatus();

  return (
    <section>
      <SessionUi.SessionStatusBadge status={session.status} />
    </section>
  );
}
