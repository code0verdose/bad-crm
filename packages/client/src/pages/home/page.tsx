import { AppStatus } from '@widgets/app-status';

/**
 * Composition only: a landmark, the page heading and the widgets that fill it.
 *
 * No data, no formatting, no conditionals — a page that knows how something is fetched is the
 * defect `rules/frontend-fsd.mdc` rule 7 exists to prevent, and the ban on TanStack Query in this
 * layer is what keeps it honest. The real dashboard replaces this page in EPIC-024; what has to
 * survive is the shape.
 */
export function HomePage() {
  return (
    <main>
      {/* Product name, not a translatable string — see index.html. */}
      <h1>Bad CRM</h1>
      <AppStatus />
    </main>
  );
}
