---
id: STORY-003-06
epic: EPIC-003
status: backlog
blocked: false
priority: must
estimate: M
---

# STORY-003-06 — Prisma, первая миграция и харнесс Testcontainers

**Как** разработчик Bad CRM **я хочу** рабочую связку Prisma + миграции + интеграционные тесты на
настоящем Postgres **чтобы** проверять SQL, миграции и (далее) RLS на реальной БД, а не на моках,
которые о политиках Postgres ничего не знают.

## Acceptance (Given/When/Then)

- **Given** `schema.prisma` с `url = env("DATABASE_URL")` и `directUrl = env("DATABASE_MIGRATION_URL")` **When** выполняю `pnpm db:migrate` на поднятом docker-стеке **Then** миграция применяется, таблица `_prisma_migrations` создана.
- **Given** первая миграция **When** смотрю её содержимое **Then** она включает расширения `pgcrypto`, `citext`, `pg_trgm`, `vector` и платформенную таблицу без данных арендатора; ключи — UUID, временные метки — `timestamptz`.
- **Given** интеграционный тест **When** он запускается **Then** Testcontainers поднимает `pgvector/pgvector:pg16`, применяет миграции, и контейнер переиспользуется на весь файл через `globalSetup`, а не создаётся на каждый тест.
- **Given** два последовательных интеграционных теста **When** между ними выполняется очистка **Then** используется `TRUNCATE ... RESTART IDENTITY CASCADE` по списку таблиц, а не пересоздание контейнера; второй тест не видит данных первого.
- **Given** миграция с `DROP COLUMN` в одном релизе со сменой кода **When** запускается проверка миграций **Then** она падает: разрушающие операции требуют двухфазного плана expand → migrate → contract.
- **Given** миграция с `CREATE INDEX` без `CONCURRENTLY` на таблице с данными **When** запускается линт миграций **Then** он выдаёт блокирующее замечание.
- **Given** применённая миграция **When** следом выполняется `pnpm db:grants` **Then** у `backup_role` есть `SELECT` на каждой таблице, партиции и последовательности (иначе `pg_dump` падает на `LOCK TABLE`), а у `app_user` — права по правилам `packages/server/prisma/sql/01-grants.sql`; повторный запуск ничего не меняет.
- **Given** отсутствие Docker в окружении **When** запускаю `pnpm test` (юнит-уровень) **Then** он проходит: интеграционные тесты выделены в отдельный vitest-проект `test:integration` и не блокируют быстрый цикл.

## Задачи

- [ ] Написать тесты первыми: `test/integration/db/migrations.test.ts` (миграции применяются на чистой БД и идемпотентны при повторе), `test/unit/db/migration-lint.test.ts` (запрещённые конструкции в файлах миграций).
- [ ] Инициализировать Prisma: `packages/server/prisma/schema.prisma`, генератор клиента, `previewFeatures` при необходимости для `postgresqlExtensions`.
- [ ] Создать первую миграцию: включение расширений + платформенная таблица (`schema_meta` / `app_setting`) без `organizationId`.
- [ ] Реализовать `infrastructure/persistence/prisma/prisma-client.ts` — создание клиента, логирование медленных запросов через `LoggerPort`, единая точка `$disconnect` в shutdown.
- [ ] Реализовать харнесс `test/integration/setup/testcontainers.ts`: `globalSetup` с поднятием контейнера, применением `prisma migrate deploy` **и последующим прогоном `01-grants.sql`**, экспортом `DATABASE_URL` для тестов; `truncateAll()` между тестами. Без грантов интеграционные тесты пойдут под `app_migrator` и не заметят ни одной ошибки в правах.
- [ ] Настроить отдельный vitest-проект `integration` и скрипт `pnpm test:integration`; подключить его к CI-джобе из [STORY-002-01](../../epic-002-ci-and-commit-gate/stories/story-002-01-ci-pipeline-turbo-checks.md).
- [ ] Реализовать `scripts/migration-lint.ts`: запрет `DROP COLUMN`/`DROP TABLE` в одном релизе с изменением кода, переименований, `CREATE INDEX` без `CONCURRENTLY`, `SET NOT NULL` без `CHECK ... NOT VALID`.
- [ ] Добавить шаблон миграции с обязательным блоком RLS-заготовки (полное наполнение — [EPIC-005](../../epic-005-multi-tenancy-rls/epic.md)) и подключить агента `db-reviewer` к гейту.

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y-проверка (для UI-историй) — не применимо
- [ ] i18n: строки в обоих языках, хардкода нет (для UI-историй) — не применимо

## Ссылки

- Документация: [`stack.md` → Работа с БД, миграции](../../../docs/architecture/stack.md), [`data-model.md` → Стратегия миграций](../../../docs/architecture/data-model.md), [`prd.md` → риск R-10](../../../docs/product/prd.md)
- Правила: `rules/testing.mdc`, `rules/tdd-and-commit-gate.mdc`
