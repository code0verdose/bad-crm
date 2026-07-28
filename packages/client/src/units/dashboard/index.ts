/**
 * Public surface of the dashboard unit.
 *
 * `model` only, for now: the screen's search contract is the first thing about the dashboard that
 * exists, and `docs/product/glossary.md` already names this unit as its home. The cards, their
 * registry and the queries behind them arrive with EPIC-024 — an empty `api` or `service` created
 * ahead of them is what `test/architecture/structure.test.ts` rejects, because a directory is a
 * claim that something is there.
 */
export * as DashboardModel from './model/index.js';
