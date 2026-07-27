import { HomePage } from '@pages';

/**
 * Root of the component tree.
 *
 * It renders one page directly because there is no router yet: TanStack Router, the provider tree
 * and the route guards arrive with STORY-004-05 and STORY-004-04, and this component becomes their
 * mounting point (`<RouterProvider />` inside `<Providers>`). Keeping it separate from `main.tsx`
 * is what lets a test render the whole application without a DOM entry point.
 */
export function App() {
  return <HomePage />;
}
