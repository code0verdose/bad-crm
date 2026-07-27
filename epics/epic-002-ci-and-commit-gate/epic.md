---
id: EPIC-002
title: CI и commit-гейт
status: review
blocked: false
milestone: M1
owner: unassigned
created: 2026-07-26
---

# EPIC-002 — CI и commit-гейт

## Зачем (ценность)

Bad CRM обещает 100 % покрытия изменённых строк, ноль кросс-тенантных утечек, ноль High/Critical
находок безопасности и лицензионную чистоту AGPL-3.0. Все эти обещания невыполнимы силой
дисциплины — их нужно сделать механическими. Эпик превращает правила проекта в блокирующие проверки
на pull request: пока CI не зелёный, изменение не попадает в основную ветку. Это же снимает
основной риск проекта — накопление долга при 46 эпиках (R-08).

## Scope

### В скоупе

- Основной CI-workflow на pull request: `typecheck`, `lint`, `build`, `test` через turborepo с кешем.
- Пороги покрытия по областям кода + baseline, блокирующий регресс покрытия.
- Отдельная job для e2e с поднятыми сервисами и публикацией артефактов.
- Блокирующий шаг сканирования секретов (gitleaks) и мусора (`scan-cruft`).
- CodeQL, `dependency-review` и проверка лицензий зависимостей на совместимость с AGPL-3.0 с allow-list.
- Шаблоны PR и issue, Dependabot, проверка Conventional Commits в CI.

### Вне скоупа

- Публикация релизных образов и версионирование — [EPIC-046](../epic-046-self-host-release-1-0/epic.md) (M9).
- Нагрузочные сценарии и регресс p95 — [EPIC-045](../epic-045-security-hardening/epic.md) и профильные эпики доменов.
- Автоматический a11y-аудит в e2e — [EPIC-007](../epic-007-design-system/epic.md) и [EPIC-010](../epic-010-e2e-harness/epic.md) (здесь только место в pipeline).
- Структурный RLS-тест по `pg_policy` — [EPIC-005](../epic-005-multi-tenancy-rls/epic.md) (CI его лишь запускает).

## Acceptance (эпик выполнен, когда)

- [ ] Любой pull request запускает `turbo run typecheck lint build test`; красный результат блокирует мерж через branch protection.
- [ ] Покрытие изменённого кода проверяется автоматически: падение ниже порога области или регресс относительно baseline валит сборку.
- [ ] E2E-job поднимает docker-стек, прогоняет Playwright и публикует trace/screenshot/video при падении.
- [ ] Найденный секрет в диффе блокирует PR; BLOCK-уровень `scan-cruft` (debugger, focused-тесты, маркеры конфликтов) блокирует PR.
- [ ] Зависимость с лицензией вне allow-list (BSL, SSPL, Commons Clause, GPL-2.0-only, проприетарная) валит сборку с указанием пакета и лицензии.
- [ ] CodeQL и `dependency-review` включены; находки High/Critical блокируют мерж.
- [ ] Заголовок PR и все коммиты ветки проверяются на Conventional Commits.
- [ ] Dependabot создаёт сгруппированные еженедельные PR; они проходят полный CI и не мержатся автоматически.
- [ ] Полный прогон CI на PR без изменений в тяжёлых пакетах укладывается в 10 минут за счёт кеша turborepo и pnpm.

## Зависимости / риски

- Зависит от: [EPIC-001](../epic-001-monorepo-and-dev-env/epic.md) (pipeline и конфиги, которые CI запускает).
- Блокирует: все последующие эпики — без гейта они не могут считаться завершёнными.
- Риски: **R-13** (AGPL-совместимость зависимостей) — митигация проверкой лицензий с allow-list; **R-08** (scope creep и размазывание качества) — митигация обязательным гейтом; ложноположительные срабатывания сканеров — митигация явным, версионируемым файлом исключений с обоснованием каждой строки.

## Ссылки

- Документация: [`stack.md` → Тестовая стратегия](../../docs/architecture/stack.md), [`stack.md` → Политика зависимостей](../../docs/architecture/stack.md), [`prd.md` → NFR-10, NFR-11, риски R-08, R-13](../../docs/product/prd.md), [`roadmap.md` → M1 критерий выхода](../../docs/product/roadmap.md)
- Правила: `rules/tdd-and-commit-gate.mdc`, `rules/commit-hygiene.mdc`, `rules/dependencies.mdc`, `rules/security.mdc`

## Истории

- [ ] [STORY-002-01 — CI на pull request: typecheck, lint, build, test](stories/story-002-01-ci-pipeline-turbo-checks.md)
- [ ] [STORY-002-02 — Пороги покрытия и baseline против регресса](stories/story-002-02-coverage-thresholds-baseline.md)
- [ ] [STORY-002-03 — E2E-job с поднятыми сервисами и артефактами](stories/story-002-03-e2e-job-with-services.md)
- [ ] [STORY-002-04 — Блокирующий скан секретов и мусора](stories/story-002-04-secret-and-cruft-scan-gate.md)
- [ ] [STORY-002-05 — CodeQL, dependency-review и проверка лицензий](stories/story-002-05-codeql-dependency-and-license-review.md)
- [ ] [STORY-002-06 — Шаблоны PR/issue, Dependabot, проверка коммитов](stories/story-002-06-pr-templates-dependabot-commitlint.md)
