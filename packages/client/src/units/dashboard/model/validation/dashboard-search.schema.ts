import { z } from 'zod';

import {
  DASHBOARD_RANGES,
  DASHBOARD_SCOPES,
  DEFAULT_DASHBOARD_RANGE,
  DEFAULT_DASHBOARD_SCOPE,
} from '@units/dashboard/model';

/**
 * `/dashboard?range=…&scope=…` — the typed state of the screen, as the URL carries it.
 *
 * Both fields are whitelists with a fallback, which is what makes `?scope=everyone` a dashboard on
 * the personal scope instead of an error screen: an unknown value is not a request to be honoured,
 * and it is not a reason to fail either (`rules/lists-and-filters.mdc`).
 */
export const dashboardSearchSchema = z.object({
  range: z.enum(DASHBOARD_RANGES).catch(DEFAULT_DASHBOARD_RANGE).default(DEFAULT_DASHBOARD_RANGE),
  scope: z.enum(DASHBOARD_SCOPES).catch(DEFAULT_DASHBOARD_SCOPE).default(DEFAULT_DASHBOARD_SCOPE),
});

export type DashboardSearch = z.infer<typeof dashboardSearchSchema>;
