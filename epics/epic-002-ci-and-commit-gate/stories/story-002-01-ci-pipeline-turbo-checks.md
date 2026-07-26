---
id: STORY-002-01
epic: EPIC-002
status: backlog
blocked: false
priority: must
estimate: M
---

# STORY-002-01 — CI на pull request: typecheck, lint, build, test

**Как** разработчик Bad CRM **я хочу** чтобы каждый pull request автоматически проходил полный
набор проверок **чтобы** сломанный код физически не попадал в основную ветку и не блокировал
работу остальных.

## Acceptance (Given/When/Then)

- **Given** открытый pull request **When** CI стартует **Then** выполняется `pnpm install --frozen-lockfile` и `turbo run typecheck lint build test`; итоговый статус публикуется как обязательная проверка.
- **Given** PR с ошибкой типов в `packages/server` **When** CI выполняет `typecheck` **Then** сборка красная, в логе виден файл и строка ошибки, последующие джобы не тратят время впустую (`fail-fast` внутри матрицы одного набора).
- **Given** изменённый `pnpm-lock.yaml`, не соответствующий `package.json` **When** CI выполняет установку **Then** `--frozen-lockfile` падает с явным сообщением, а не молча пересчитывает lock.
- **Given** повторный запуск CI на том же коммите **When** turbo и pnpm store восстанавливаются из кеша **Then** прогон завершается заметно быстрее холодного (кеш-хиты видны в логе), и результат идентичен.
- **Given** PR, меняющий только `docs/**` или `epics/**` **When** срабатывают path-фильтры **Then** тяжёлые джобы (build, test, e2e) пропускаются, но обязательная проверка всё равно отчитывается как успешная (не «pending навсегда»).
- **Given** упавший тест **When** CI завершается **Then** отчёт тестов публикуется как job summary с именами упавших тестов, не требуя раскрытия сырых логов.
- **Given** ветка `main` **When** кто-то пытается запушить напрямую **Then** branch protection отклоняет push: изменения идут только через PR с зелёными проверками.

## Задачи

- [ ] Написать/зафиксировать проверочный сценарий: `.github/workflows/ci.yml` валидируется `actionlint` в отдельном шаге, а тест `test/ci/workflow.test.ts` проверяет наличие обязательных джобов и шагов (frozen lockfile, кеш, все четыре задачи).
- [ ] Создать `.github/workflows/ci.yml`: триггеры `pull_request` и `push` в `main`, `concurrency` с отменой предыдущих прогонов ветки, `permissions` минимальные (`contents: read`).
- [ ] Настроить шаги: `actions/checkout` (fetch-depth для diff), `pnpm/action-setup` + `actions/setup-node@v4` с `cache: pnpm`, кеш turborepo (`.turbo`), `pnpm install --frozen-lockfile`.
- [ ] Настроить запуск `turbo run typecheck lint build test` одной командой с `--output-logs=errors-only` и публикацией summary.
- [ ] Добавить job `integration` с сервисами Postgres 16 + pgvector и Redis (или Testcontainers) для `pnpm test:integration` — точка подключения RLS-тестов из [EPIC-005](../../epic-005-multi-tenancy-rls/epic.md).
- [ ] Настроить path-фильтры и «always green» заглушку для doc-only PR.
- [ ] Описать в `docs/runbooks/ci.md`: состав джобов, как воспроизвести падение локально, как чистить кеш.
- [ ] Включить branch protection на `main`: обязательные проверки, запрет прямого push, требование актуальности ветки.

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y-проверка (для UI-историй) — не применимо
- [ ] i18n: строки в обоих языках, хардкода нет (для UI-историй) — не применимо

## Ссылки

- Документация: [`stack.md` → Команды](../../../docs/architecture/stack.md), [`prd.md` → NFR-10](../../../docs/product/prd.md)
- Правила: `rules/tdd-and-commit-gate.mdc`
