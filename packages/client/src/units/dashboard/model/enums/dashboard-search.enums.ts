/**
 * The two axes of the dashboard: how far back it looks, and whose work it shows
 * (`ux-architecture.md` → «Каркас приложения»).
 *
 * Closed unions rather than free strings, because both reach a query on the server and both are
 * typed into the URL by anyone who edits it. `docs/product/glossary.md` names this unit
 * `units/dashboard` — one screen for all three roles, differing in the scope of the data rather
 * than in the components (принцип 8).
 */
export const DASHBOARD_RANGES = ['today', '7d', '30d', 'quarter'] as const;

export type DashboardRange = (typeof DASHBOARD_RANGES)[number];

export const DASHBOARD_SCOPES = ['me', 'team', 'org'] as const;

export type DashboardScope = (typeof DASHBOARD_SCOPES)[number];

export const DEFAULT_DASHBOARD_RANGE: DashboardRange = '7d';
export const DEFAULT_DASHBOARD_SCOPE: DashboardScope = 'me';
