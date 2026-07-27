---
id: STORY-001-04
epic: EPIC-001
status: review
blocked: false
priority: must
estimate: M
---

# STORY-001-04 — docker-compose с полным набором dev-сервисов

**Как** разработчик Bad CRM **я хочу** поднять PostgreSQL с pgvector, Redis, MinIO, Meilisearch и
Mailpit одной командой **чтобы** локальная среда совпадала с целевой self-host-конфигурацией и не
требовала ручной установки пяти сервисов.

## Acceptance (Given/When/Then)

- **Given** чистая машина с Docker 24 и Compose v2 **When** выполняю `pnpm docker:up` **Then** поднимаются пять сервисов, каждый с зафиксированной версией образа, и команда завершается только после того, как все healthcheck перешли в `healthy`.
- **Given** поднятый Postgres **When** выполняю `SELECT extversion FROM pg_extension WHERE extname = 'vector'` **Then** расширение установлено; так же доступны `pgcrypto`, `citext`, `pg_trgm`.
- **Given** остановленный и заново поднятый стек (`pnpm docker:down && pnpm docker:up`) **When** проверяю содержимое БД и бакета MinIO **Then** данные сохранились: используются именованные тома `pgdata`, `redis-data`, `minio-data`, `meili-data`.
- **Given** сервис Postgres, который ещё инициализируется **When** приложение стартует через `depends_on: { condition: service_healthy }` **Then** оно не пытается подключиться раньше готовности БД и не падает с `ECONNREFUSED`.
- **Given** профиль `minimal` (`docker compose --profile minimal up`) **When** смотрю список контейнеров **Then** Meilisearch не поднят, а Postgres, Redis и MinIO работают.
- **Given** занятый на хосте порт 5432 **When** выполняю `pnpm docker:up` **Then** используется настраиваемый через `.env` порт публикации (`POSTGRES_PORT`), и конфликт решается правкой одной переменной, а не compose-файла.
- **Given** запущенный MinIO **When** стартует стек **Then** init-контейнер идемпотентно создаёт бакет `bad-crm` и сервисный ключ доступа; повторный запуск не падает.

## Задачи

- [ ] Написать тест окружения `test/env/compose.test.ts`: парсит `docker-compose.yml` и проверяет — у каждого сервиса задан `healthcheck`, тег образа не `latest`, объявлен именованный том, порты берутся из переменных.
- [ ] Написать smoke-скрипт `scripts/check-services.ts`: подключается к Postgres (`SELECT 1` + список расширений), Redis (`PING`), MinIO (`HeadBucket`), Meilisearch (`GET /health`), Mailpit (`GET /api/v2/messages`) и печатает сводку.
- [ ] Создать `docker-compose.yml`: `postgres` (`pgvector/pgvector:pg16`), `redis` (`redis:8.x-alpine` с AOF — 7.x запрещён лицензией, см. docs/legal/licensing.md §4), `minio` (`minio/minio`), `minio-init`, `meilisearch` (`getmeili/meilisearch:v1.x`, профиль `default`), `Mailpit`.
- [ ] Смонтировать `packages/server/prisma/sql/` в `/docker-entrypoint-initdb.d/` — точка расширения для bootstrap-скрипта ролей из [EPIC-005](../../epic-005-multi-tenancy-rls/epic.md); в этой истории создаётся только каталог и скрипт включения расширений `01-extensions.sql`.
- [ ] Добавить профили `minimal` и `default`, распределив сервисы по ним согласно [`stack.md`](../../../docs/architecture/stack.md).
- [ ] Добавить корневые скрипты `docker:up` (с `--wait`), `docker:down`, `docker:reset` (удаление томов с подтверждением), `docker:logs`.
- [ ] Прописать в `docs/runbooks/local-environment.md` порядок диагностики: какой контейнер за что отвечает, как посмотреть логи, как сбросить том.

## Отклонения от плана

- **Bootstrap-роли БД сделаны раньше плана.** Задача выше откладывала `00-bootstrap-roles.sql` на [EPIC-005](../../epic-005-multi-tenancy-rls/epic.md), оставляя здесь только каталог и `01-extensions.sql`. Реализация создала роли (`app_migrator`, `app_user`, `app_auth`, `backup_role`) уже в этой истории.
  **Обоснование:** роли нужны до первой миграции, а не после неё. `DATABASE_URL` и `DATABASE_MIGRATION_URL` из STORY-001-05 указывают на разные роли, и `.env.example` обязан их описать; если первая миграция пройдёт под суперпользователем, владельцем таблиц станет он, и последующее `FORCE ROW LEVEL SECURITY` будет применено к схеме, которую придётся переливать. Инициализация ролей возможна только при первом старте контейнера Postgres — отложить её значит требовать `docker:reset` со сносом тома у каждого, кто уже поднял стек.
  **Что осталось за EPIC-005:** сами политики RLS, `withTenant`/`guardedClient`, isolation-тесты с положительным контролем. Здесь создан только фундамент ролей и грантов.

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y-проверка (для UI-историй) — не применимо
- [ ] i18n: строки в обоих языках, хардкода нет (для UI-историй) — не применимо

## Ссылки

- Документация: [`stack.md` → Требования к среде](../../../docs/architecture/stack.md), [`overview.md` → Развёртывание](../../../docs/architecture/overview.md), [`prd.md` → NFR-3, риск R-14](../../../docs/product/prd.md)
- Правила: `rules/dependencies.mdc`, `rules/security.mdc`
