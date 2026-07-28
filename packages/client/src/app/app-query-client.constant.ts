import { SharedApi, SharedUi } from '@shared';

import { reportClientError } from './report-client-error.util.js';

/**
 * The application's one query cache, with the two seams of the data layer finally connected.
 *
 * `notify` closes the first one: `createAppQueryClient` announces a failed mutation through a
 * `NotificationPort`, and until now the port passed was `silentNotifications` — a complete
 * implementation of «do not notify», which is exactly one line away from every failure in the
 * application being invisible. That line is this one.
 *
 * One instance for the whole application, because it is the cache: a second client would serve a
 * second copy of every entity, and an invalidation in one would leave the other stale.
 */
export const appQueryClient = SharedApi.createAppQueryClient({
  notify: SharedUi.notify,
  logError: reportClientError,
});
