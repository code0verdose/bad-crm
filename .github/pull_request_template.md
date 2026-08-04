<!--
  The full process is in CONTRIBUTING.md — this template only asks for what a reviewer
  cannot reconstruct from the diff. Delete nothing: an item that does not apply is marked
  `n/a` with a reason, and an empty checklist is itself a review finding.
-->

## What and why

<!-- What changes, and which problem it solves. Not how — the diff already says how. -->

## Story

<!--
  One line: `Implements STORY-NNN-NN` plus the link, e.g.
  Implements STORY-002-05 — epics/epic-002-ci-and-commit-gate/stories/story-002-05-codeql-dependency-and-license-review.md

  No story? Write `no-story: <reason>` — CI accepts that, reviewers judge the reason.
  "No code without an active epic and story" (CONTRIBUTING.md §7).
-->

Implements STORY-

## Risk and rollback

<!--
  What breaks if this is wrong, who notices first, and how it is undone: revert, feature
  flag, down migration, or "not revertible after the migration runs — here is why that is
  acceptable". For a self-hosted product, also: what an existing installation experiences
  on upgrade.
-->

## Checklist

Every pull request:

- [ ] Tests were written first and fail without the change; changed lines **and branches** are covered.
- [ ] `pnpm turbo run typecheck lint build test` is green locally (`rules/ci-before-push.mdc`).
- [ ] The commit gate is green — all six checks in `CONTRIBUTING.md` §4 ("The commit gate").
- [ ] The project agents triggered by this diff pass (RLS, permissions, crypto, API contract, FSD, realtime, search, i18n, upgrade safety).
- [ ] Every user-visible string this diff adds exists in **both** `en` and `ru`. Translation is part of the story that introduces the string, never a follow-up: a key shipped in one language is a screen that renders its own key at half the people who open it.
- [ ] Commits follow Conventional Commits and are signed off (`git commit -s`, DCO 1.1).
- [ ] `docs/` is accurate for this change; a new architectural decision has an ADR.
- [ ] A journal entry exists in `docs/brain/`.
- [ ] The story file is updated (tasks ticked, status moved).

The three invariants — tick, or write `n/a` and why (`CLAUDE.md`):

- [ ] **Tenancy.** Every new table has `organization_id`, `ENABLE` **and** `FORCE ROW LEVEL SECURITY`, a policy with **both** `USING` and `WITH CHECK` on `app_user`, explicit `GRANT`s, composite foreign keys, and an isolation test **with a positive control**. Worked through the new-table checklist in `docs/security/rls-design.md` (section «Чек-лист "новая таблица"») rather than from memory.
- [ ] **Permissions.** Every new endpoint declares a permission from `packages/shared/src/permissions/permissions.catalog.ts` and the check runs **in the use-case**, not only in middleware. Cross-organization access returns **404**, not 403. List endpoints filter in SQL.
- [ ] **Vault.** Nothing decrypted leaves the browser — not to the server, logs, telemetry, the search index, or AI context. No key material in `localStorage`, `sessionStorage`, IndexedDB, cookies, router state, query cache, or URLs.

If this pull request touches:

- [ ] **UI** — strings exist in EN **and** RU with no hardcoded text; keyboard reachable and focus visible; loading, empty and error states exist.
- [ ] **Database** — expand → migrate → contract; no blocking DDL; the migration is safe to run on a live installation.
- [ ] **API** — `docs/api/openapi.yaml` updated and the generated client types regenerated and committed.
- [ ] **Environment, compose or profiles** — new variables are in `.env.example` **and** `docs/runbooks/upgrade.md`; the `minimal` profile still starts; `CHANGELOG.md` updated.
- [ ] **Dependencies** — latest stable, licence on the allow-list in `rules/dependencies.mdc` §8, supply-chain checked; a new install script is added to `pnpm.onlyBuiltDependencies` with a reason.
