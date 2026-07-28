import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * `/` — a redirect, not a screen.
 *
 * Thrown from `beforeLoad` rather than rendered as a component that navigates on mount: this way
 * nothing mounts, nothing flashes, and the browser history contains `/dashboard` instead of an
 * entry that bounces the user forward again every time they press Back.
 */
export const Route = createFileRoute('/_authenticated/')({
  beforeLoad: () => {
    throw redirect({ to: '/dashboard', replace: true });
  },
});
