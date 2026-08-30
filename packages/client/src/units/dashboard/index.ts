/**
 * Public surface of the dashboard unit.
 *
 * `model` only, for now: the screen's search contract is the first thing about the dashboard that
 * exists, and `docs/product/glossary.md` already names this unit as its home. The cards, their
 * registry and the queries behind them arrive with EPIC-031 (`epics/epic-031-dashboards/`, M6).
 * This said EPIC-024 until 2026-08-30; EPIC-024 is `epic-024-search-meilisearch` and always was —
 * a wrong number, not a moved epic. An empty `api` or `service` created
 * ahead of them is what `test/architecture/structure.test.ts` rejects, because a directory is a
 * claim that something is there.
 */
export * as DashboardModel from './model/index.js';
