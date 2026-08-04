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

/**
 * What each value is called on screen — a **key**, never a sentence (`rules/i18n.mdc` §1).
 *
 * Written out rather than assembled from the union, for the reason ADR-0019 gives: a key built as
 * `dashboard.range.${value}` is invisible to the parity gate, so a catalogue missing all four would
 * pass every check and render `dashboard.range.7d` at a reader. `Record<Union, string>` is what
 * makes a new value a compile error instead of a missing translation.
 */
export const DASHBOARD_RANGE_LABEL_KEY: Readonly<Record<DashboardRange, string>> = {
  today: 'dashboard.range.today',
  // `last7Days`, not `7d`: the parity gate finds keys by pattern, and a segment starting with a
  // digit is not one it recognises — so `dashboard.range.7d` read as an orphan entry nobody asks
  // for. Renaming the key is cheaper than widening a heuristic that would then match `v1.2.3`.
  '7d': 'dashboard.range.last7Days',
  '30d': 'dashboard.range.last30Days',
  quarter: 'dashboard.range.quarter',
};

export const DASHBOARD_SCOPE_LABEL_KEY: Readonly<Record<DashboardScope, string>> = {
  me: 'dashboard.scope.me',
  team: 'dashboard.scope.team',
  org: 'dashboard.scope.org',
};
