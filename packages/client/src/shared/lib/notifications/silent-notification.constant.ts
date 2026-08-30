import { type NotificationPort } from './notification.types.js';

/**
 * A complete implementation of "do not notify", not an unfinished one.
 *
 * Two callers have it for good: a test that asserts on cache behaviour rather than on toasts, and
 * any host with no screen to put a toast on.
 *
 * There used to be a third, and it is gone (2026-08-30). This docstring claimed the application
 * shell passed this port «until `shared/ui/toaster` exists (EPIC-007)»; EPIC-007 shipped, the
 * toaster exists, and `app/app-query-client.constant.ts` passes `SharedUi.notify`. The one line
 * that had to change has changed — nothing in the running application is silent any more.
 */
export const silentNotifications: NotificationPort = {
  error: () => undefined,
  success: () => undefined,
};
