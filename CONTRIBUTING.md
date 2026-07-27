# Contributing to Bad CRM

Thank you for considering a contribution. Please read this document before opening a pull request —
this project has stricter-than-usual process rules, and they are enforced by automation, not by
goodwill.

**Current phase: design.** There is no code yet — no `packages/`, no `docker-compose.yml`, no
release. The most valuable contributions right now are review of the specification in [`docs/`](docs/)
and the work breakdown in [`epics/`](epics/): finding a hole in the threat model or an inconsistency
between the data model and a story is worth more than a patch to code that does not exist.

Русская версия ключевых разделов — в конце документа: [По-русски](#по-русски).

---

## Table of contents

1. [Setting up the environment](#1-setting-up-the-environment)
2. [Repository layout](#2-repository-layout)
3. [Test-driven development is mandatory](#3-test-driven-development-is-mandatory)
4. [The commit gate](#4-the-commit-gate)
5. [Conventional Commits](#5-conventional-commits)
6. [The rules in `rules/` are binding](#6-the-rules-in-rules-are-binding)
7. [Epics and stories](#7-epics-and-stories)
8. [Code review](#8-code-review)
9. [DCO — Developer Certificate of Origin](#9-dco--developer-certificate-of-origin)
10. [Definition of Done](#10-definition-of-done)
11. [По-русски](#по-русски)

---

## 1. Setting up the environment

**Requirements** (as specified in [`docs/architecture/stack.md`](docs/architecture/stack.md)):

| Tool | Version |
|---|---|
| Node.js | 22 LTS (`>=22.11 <23`) — pinned in `.nvmrc` |
| pnpm | 9+ via Corepack |
| Docker | 24+ with Compose v2 |
| OS | Linux, macOS, or WSL2 (native Windows is not supported — Testcontainers and volume permissions) |

Resources: 8 GB RAM (4 GB with the `minimal` profile), 10 GB of disk.

**Intended flow** (available from EPIC-001 onward; today only the clone step works):

```bash
git clone https://github.com/<org>/bad-crm.git
cd bad-crm
corepack enable
pnpm install
cp .env.example .env          # then fill in the CHANGE_ME_ placeholders
pnpm docker:up                # Postgres, Redis, MinIO, Meilisearch, Mailpit
pnpm db:migrate && pnpm db:seed
pnpm dev
```

Useful commands (full list in [`docs/architecture/stack.md`](docs/architecture/stack.md)):

| Command | What it does |
|---|---|
| `pnpm dev` | Server (tsx watch) and client (Vite) in parallel |
| `pnpm test` | Vitest unit and application tests |
| `pnpm test:integration` | Testcontainers: RLS and repositories against a real PostgreSQL |
| `pnpm test:e2e` | Playwright over a running stack |
| `pnpm lint` / `pnpm typecheck` / `pnpm build` | The individual CI checks |
| `pnpm turbo run typecheck lint build test` | **Everything CI runs — must be green before push** |
| `pnpm api:gen` | Regenerate client types from `docs/api/openapi.yaml` |

Never push on a red or unrun pipeline. See [`rules/ci-before-push.mdc`](rules/ci-before-push.mdc).

---

## 2. Repository layout

```
bad-crm/
├─ CLAUDE.md      # working agreement: invariants, sources of truth, gate
├─ docs/          # specification — the source of truth (see docs/README.md)
├─ epics/         # work breakdown: 46 epics, stories under epics/*/stories/
├─ rules/         # 34 binding development rules (.mdc)
├─ .claude/agents/# 9 project-specific review agents
└─ packages/      # (from EPIC-001) shared · server · client · e2e
```

Dependency direction is strictly one-way and enforced by lint in CI:
`client → shared`, `server → shared`, `shared → nothing`, `e2e → nothing from sources`.

Server code is hexagonal (`domain / application / infrastructure / presentation`); client code is
Feature-Sliced Design in the "units" flavour (`app → pages → widgets → units → shared`). File names
are always kebab-case with a role suffix (`task-access.policy.ts`, `user-card.component.tsx`).
Details: [`rules/hexagonal-backend.mdc`](rules/hexagonal-backend.mdc),
[`rules/frontend-fsd.mdc`](rules/frontend-fsd.mdc),
[`rules/naming-and-structure.mdc`](rules/naming-and-structure.mdc).

---

## 3. Test-driven development is mandatory

Every change follows **Red → Green → Refactor**:

1. **Red** — write the failing test first and demonstrate that it fails. For a bug, the first commit
   is a test that reproduces the bug.
2. **Green** — write the minimum code that makes it pass.
3. **Refactor** — clean up with the tests staying green.

Cover more than the happy path: errors, boundaries, empty and invalid input, concurrency. A pull
request whose tests were clearly written after the implementation, or whose tests assert nothing
meaningful, will be sent back.

Test levels and thresholds are defined in [`rules/testing.mdc`](rules/testing.mdc). Two categories
are non-negotiable:

- **Tenant isolation tests** for every new table, and they must include a **positive control** — the
  test has to prove both that another organization's row is invisible *and* that your own row is
  visible. A test without a positive control passes on a broken connection.
- **Permission tests** for every new endpoint, at the use-case level, against the policy — not only
  through HTTP.

---

## 4. The commit gate

No commit and no push until all six checks pass — even if someone already asked for a commit. Gate
first, commit second.

| # | Check | Agent / tool |
|---|---|---|
| 1 | Tests pass; changed lines and branches are covered; TDD was actually followed | `test-coverage` |
| 2 | No High/Critical security findings, no secrets, no vulnerable dependencies | `security-auditor` |
| 3 | Schema, migrations, and queries are safe — no data loss, no blocking migration, rolling-deploy compatible | `db-reviewer` (when the diff touches the database) |
| 4 | Production readiness: error handling, logging, config, performance, rollback | `production-readiness` |
| 5 | Commit hygiene: no leftover fallbacks, mock data, debug statements, throwaway scripts | `commit-hygiene` |
| 6 | Knowledge journal updated | `docs/brain/` |

**Plus the project-specific gates** in [`.claude/agents/`](.claude/agents/), each triggered by what
the diff touches: `tenancy-rls-auditor`, `permission-matrix-auditor`, `e2ee-crypto-reviewer`,
`openapi-contract-guardian`, `fsd-architecture-linter`, `realtime-event-reviewer`,
`search-permission-auditor`, `i18n-coverage-checker`, `selfhost-upgrade-checker`. Their trigger
conditions are documented in [`CLAUDE.md`](CLAUDE.md).

Any FAIL blocks the commit. Fix it (test first), then re-run only the affected checks.

### Three invariants that are never traded away

These are described in full in [`CLAUDE.md`](CLAUDE.md); a pull request violating any of them is
rejected regardless of how good the rest of it is.

1. **Every tenant table has `organizationId` and RLS** — `ENABLE` **and** `FORCE`, a policy with both
   `USING` and `WITH CHECK`, plus an isolation test with a positive control.
2. **Every endpoint declares a permission from the shared catalog and checks it in the use-case**,
   not only in middleware. A missing resource returns 404, never 403 across organizations.
3. **Nothing decrypted from the vault leaves the browser** — not to the server, not to logs, not to
   telemetry, not to the search index, not to AI context.

---

## 5. Conventional Commits

Commit messages are in **English** and follow Conventional Commits:

```
<type>(<scope>): <subject>

<body>

<footer>
```

- `type`: `feat` | `fix` | `docs` | `style` | `refactor` | `perf` | `test` | `build` | `ci` |
  `chore` | `revert`.
- `scope`: the affected area or package — `feat(vault):`, `fix(rls):`, `chore(deps):`.
- `subject`: imperative mood, lowercase, no trailing period, 50 characters or fewer ("add", not
  "added" or "adds").
- `body`: what and **why**, not how; wrapped at about 72 characters.
- `footer`: `BREAKING CHANGE: …`, `Refs: #123`, `Closes #123`, and the mandatory `Signed-off-by`
  (see [DCO](#9-dco--developer-certificate-of-origin)).

One commit is one logical change. Commit messages are validated by commitlint in a local hook and in
CI. Examples:

```
feat(payments): add invoice status transitions
fix(db): prevent N+1 in project members query
refactor(ui): extract task card header
chore(deps): bump prisma to 6.2
```

---

## 6. The rules in `rules/` are binding

[`rules/`](rules/) contains 34 `.mdc` files. They are **requirements, not suggestions** — reviewers
cite them by filename and a violation is a change request.

Files with `alwaysApply: true` apply to every change: TDD and the commit gate, CI before push, commit
hygiene, epic-driven development, agent orchestration, naming and structure, tenancy and RLS,
permissions, security, i18n, a11y, FSD, hexagonal backend, testing.

The rest apply based on what you touched (`globs` in the front matter) — for example
[`rules/e2ee-crypto.mdc`](rules/e2ee-crypto.mdc) for anything near the vault,
[`rules/db-migrations.mdc`](rules/db-migrations.mdc) for schema changes,
[`rules/api-contract.mdc`](rules/api-contract.mdc) for endpoints. The mapping of rule to situation is
tabulated in [`CLAUDE.md`](CLAUDE.md).

If a rule seems wrong, argue about the rule in an issue — do not quietly ignore it in a pull request.

---

## 7. Epics and stories

**No code without an active epic and story.** One epic in progress at a time.

- Epics live in `epics/epic-NNN-<slug>/epic.md`, stories in `.../stories/story-NNN-XX-<slug>.md`.
- Front matter carries `id`, `status`, `blocked`, `milestone` (epic) or `priority`, `estimate` (story).
- Statuses: `backlog → ready → in-progress → review → done`. **`blocked` is a separate flag**, not a
  status — a blocked story keeps its status and sets `blocked: true`.
- Moving to `review` or `done` requires a **green commit gate**. No exceptions.
- A story is a **vertical slice of value** (INVEST), not a technical layer. Acceptance criteria are
  written as Given/When/Then.
- Epic order comes from [`docs/product/roadmap.md`](docs/product/roadmap.md): the permission layer
  precedes domains, the crypto foundation precedes the vault, time tracking precedes analytics.
- If [`docs/`](docs/) turns out to be wrong, fix `docs/` first, then the code. Silent divergence is
  the failure mode this rule exists to prevent.
- Architectural decisions made along the way are recorded as a new ADR in
  [`docs/architecture/adr/`](docs/architecture/adr/).

Stories currently exist for M1 and M2 (113 of them). Stories for later milestones are written at the
kickoff of their milestone, on purpose — writing them a year early means writing them twice.

Full rule: [`rules/epic-driven-development.mdc`](rules/epic-driven-development.mdc).

---

## 8. Code review

**What a pull request must contain:**

- A link to the story it implements, and nothing outside that story's scope.
- Tests that were written first and that fail without the change.
- The `docs/` update, if the change makes any document inaccurate.
- A `docs/brain/` journal entry describing what was done and why.
- Green CI: `typecheck`, `lint`, `build`, `test`, plus integration and e2e when relevant.

**What reviewers check, in this order:**

1. **The three invariants.** Tenancy, permissions, vault. A problem here stops the review.
2. **Correctness against the story's acceptance criteria.** Does it do what was agreed, and only that?
3. **Layer boundaries.** Domain free of I/O, access decisions in policies, no `prisma.*` outside
   `infrastructure/persistence/`, no data fetching in pages or widgets, imports through barrels.
4. **Tests.** Are they meaningful, do they cover errors and boundaries, is the positive control there?
5. **Operational safety.** Migration strategy, backward compatibility, what happens on rollback, what
   an existing self-hosted installation experiences.
6. **The small stuff.** Naming, i18n keys, accessibility, error and loading states.

**Etiquette:** review the code, not the person. Distinguish blocking findings from preferences and
say which is which. If you request a change, say what the failure scenario is — "this is wrong"
without a concrete consequence is not a review comment. Authors: answer every comment, even if the
answer is "no, and here is why".

Keep pull requests small. A 2000-line pull request does not get reviewed, it gets approved.

---

## 9. DCO — Developer Certificate of Origin

This project uses a **DCO instead of a CLA**. There is no copyright assignment and no separate
agreement to sign: you keep the copyright to your contribution, and the project cannot be
relicensed out from under you.

Sign off every commit:

```bash
git commit -s -m "feat(tasks): add column reordering"
```

which appends:

```
Signed-off-by: Jane Doe <jane@example.com>
```

Use your real name and a working email address. The sign-off certifies the statement below.

### Developer Certificate of Origin 1.1

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

Contributions are accepted under **AGPL-3.0-or-later**, the license of the project.

---

## 10. Definition of Done

A story is done when **all** of the following are true:

- [ ] Tests were written first (TDD), they pass, and the changed lines and branches are covered.
- [ ] All acceptance criteria from the story are satisfied and verified.
- [ ] The commit gate is green: `test-coverage`, `security-auditor`, `db-reviewer` (if the database
      was touched), `production-readiness`, `commit-hygiene`.
- [ ] The relevant project agents pass: RLS, permissions, crypto, API contract, FSD, realtime,
      search, i18n, upgrade safety — whichever the diff triggers.
- [ ] `pnpm turbo run typecheck lint build test` is green locally and in CI.
- [ ] New tables have `organizationId`, `ENABLE` + `FORCE` RLS, a policy with `USING` and
      `WITH CHECK`, and an isolation test with a positive control.
- [ ] New endpoints declare a permission from the catalog, check it in the use-case, appear in
      `docs/api/openapi.yaml`, and the generated client types are regenerated and committed.
- [ ] All user-visible strings exist in **both** EN and RU; no hardcoded text.
- [ ] Accessibility: keyboard reachable, focus visible, WCAG 2.1 AA contrast, no new axe violations.
- [ ] Loading, empty, and error states exist for every new screen.
- [ ] Migrations follow expand → migrate → contract; new required environment variables are added to
      `.env.example` **and** to [`docs/runbooks/upgrade.md`](docs/runbooks/upgrade.md).
- [ ] `docs/` is accurate; new architectural decisions have an ADR.
- [ ] The `docs/brain/` journal entry is written.
- [ ] The story's status is updated, and any decisions or deviations are recorded.

---

# По-русски

Ключевые разделы для русскоязычных контрибьюторов. Полный текст — выше, на английском; при
расхождении английская версия считается основной.

## Поднятие окружения

Node.js 22 LTS (зафиксирован в `.nvmrc`), pnpm 9+ через Corepack, Docker 24+ с Compose v2, Linux /
macOS / WSL2. Нативный Windows не поддерживается.

```bash
corepack enable
pnpm install
cp .env.example .env          # заполнить плейсхолдеры CHANGE_ME_
pnpm docker:up
pnpm db:migrate && pnpm db:seed
pnpm dev
```

Команды доступны начиная с EPIC-001 — сейчас работает только клонирование репозитория.

**Перед каждым push:** `pnpm turbo run typecheck lint build test`. Красный или непрогнанный
пайплайн — push запрещён.

## TDD обязателен

Цикл Red → Green → Refactor. Сначала падающий тест — и он должен быть показан падающим. Для бага
первым коммитом идёт тест, воспроизводящий баг. Покрываются не только happy path, но и ошибки,
границы, пустые и невалидные входы, конкурентность.

Два вида тестов не подлежат обсуждению:

- **Тесты изоляции арендаторов** на каждую новую таблицу — обязательно **с положительным контролем**:
  тест доказывает и что чужая строка не видна, и что своя видна. Без положительного контроля тест
  проходит даже на сломанном соединении.
- **Тесты прав** на каждый новый endpoint — на уровне use-case, против policy, а не только через HTTP.

## Commit-гейт

Ни коммита, ни push до прохождения всех шести проверок — даже если о коммите уже попросили. Сначала
гейт: тесты и покрытие (`test-coverage`), безопасность (`security-auditor`), база данных
(`db-reviewer`, если задета), продакшен-готовность (`production-readiness`), чистота коммита
(`commit-hygiene`), обновлённая база знаний (`docs/brain/`).

Плюс проектные агенты из [`.claude/agents/`](.claude/agents/) — по тому, что задела дельта: RLS,
права, крипто, контракт API, FSD, realtime, поиск, i18n, обновляемость self-host.

**Три инвариантa, которые не размениваются ни при каких обстоятельствах** (подробно — в
[`CLAUDE.md`](CLAUDE.md)):

1. Любая новая таблица — `organizationId` + RLS (`USING` **и** `WITH CHECK`, `ENABLE` + `FORCE`) +
   isolation-тест с положительным контролем.
2. Любой новый endpoint — объявленная permission из каталога и проверка **в use-case**, а не только
   в middleware.
3. Ничего расшифрованного из vault не уходит на сервер, в логи, телеметрию, поиск и контекст AI.

## Conventional Commits

Сообщения коммитов — **на английском**, в формате `<type>(<scope>): <subject>`. Тип из списка
`feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert`; subject — imperative mood, lowercase,
без точки, до 50 символов. Один коммит — одно логическое изменение. Проверяется commitlint.

## Правила `rules/*.mdc` обязательны

34 файла в [`rules/`](rules/) — это требования, а не рекомендации. Часть применяется всегда
(`alwaysApply: true`), часть — по области изменений. Ревьюер ссылается на них по имени файла, и
нарушение означает возврат на доработку. Считаете правило неверным — спорьте о правиле в issue, а не
игнорируйте его молча в пул-реквесте.

## Процесс эпиков и историй

Кода без активного эпика и истории не бывает; в работе один эпик за раз. Статусы:
`backlog → ready → in-progress → review → done`, при этом **`blocked` — отдельный флаг**, а не
статус. Переход в `review` и `done` — только на зелёном гейте. История — вертикальный срез ценности
с критериями Given/When/Then, а не технический слой. Если `docs/` оказался неверен — сначала
правится `docs/`, потом код.

## Код-ревью

Пул-реквест содержит ссылку на историю, тесты, написанные первыми, обновлённые `docs/` при
необходимости, запись в `docs/brain/` и зелёный CI. Ревьюер смотрит по порядку: три инварианта →
соответствие критериям приёмки → границы слоёв → осмысленность тестов → операционная безопасность →
детали (нейминг, i18n, a11y, состояния экрана). Ревьюим код, а не человека; блокирующее замечание
отделяем от вкусового и называем конкретный сценарий отказа. Пул-реквесты держим маленькими.

## DCO вместо CLA

Подписывайте каждый коммит: `git commit -s`. Это добавляет строку `Signed-off-by: Имя <email>` и
означает согласие с текстом DCO 1.1 (приведён выше на английском — это канонический текст, перевод
не имеет силы). Копирайт остаётся за вами; отдельного соглашения подписывать не нужно. Вклад
принимается под лицензией **AGPL-3.0-or-later**.

## Definition of Done

История закрыта, когда: тесты написаны первыми и проходят, все критерии приёмки выполнены, гейт
зелёный, профильные агенты пройдены, `typecheck lint build test` зелёные, у новых таблиц есть
`organizationId` + RLS + isolation-тест с положительным контролем, у новых endpoint'ов —
объявленная permission и запись в `openapi.yaml` с регенерированными типами, все строки есть на EN и
RU, доступность соблюдена, состояния загрузки/пустоты/ошибки реализованы, миграции следуют
expand→migrate→contract, новые обязательные переменные окружения добавлены в `.env.example` **и** в
[`docs/runbooks/upgrade.md`](docs/runbooks/upgrade.md), `docs/` актуальна, запись в `docs/brain/`
сделана, статус истории обновлён.
