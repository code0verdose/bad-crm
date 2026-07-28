import { type NotificationPort } from './notification.types.js';

/**
 * A complete implementation of "do not notify", not an unfinished one.
 *
 * Two callers have it for good: a test that asserts on cache behaviour rather than on toasts, and
 * any host with no screen to put a toast on. The third is temporary — the application shell passes
 * this port until `shared/ui/toaster` exists (EPIC-007), which is the one line that has to change
 * for every failure in the application to become visible.
 */
export const silentNotifications: NotificationPort = {
  error: () => undefined,
  success: () => undefined,
};
