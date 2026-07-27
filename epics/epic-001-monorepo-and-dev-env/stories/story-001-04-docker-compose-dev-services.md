---
id: STORY-001-04
epic: EPIC-001
status: done
blocked: false
priority: must
estimate: M
---

# STORY-001-04 — docker-compose с полным набором dev-сервисов

**Как** разработчик Bad CRM **я хочу** поднять PostgreSQL с pgvector, Redis, MinIO, Meilisearch и
Mailpit одной командой **чтобы** локальная среда совпадала с целевой self-host-конфигурацией и не
требовала ручной установки пяти сервисов.

## Acceptance (Given/When/Then)

- [x] **Given** чистая машина с Docker 24 и Compose v2 **When** выполняю `pnpm docker:up` **Then** поднимаются пять сервисов, каждый с зафиксированной версией образа, и команда завершается только после того, как все healthcheck перешли в `healthy`.
- [x] **Given** поднятый Postgres **When** выполняю `SELECT extversion FROM pg_extension WHERE extname = 'vector'` **Then** расширение установлено; так же доступны `pgcrypto`, `citext`, `pg_trgm`. *Проверяется автоматически: `pnpm check:services` требует пять расширений, включая `btree_gist`.*
- [x] **Given** остановленный и заново поднятый стек (`pnpm docker:down && pnpm docker:up`) **When** проверяю содержимое БД и бакета MinIO **Then** данные сохранились: используются именованные тома `pgdata`, `redis-data`, `minio-data`, `meili-data`.
- [ ] **Given** сервис Postgres, который ещё инициализируется **When** приложение стартует через `depends_on: { condition: service_healthy }` **Then** оно не пытается подключиться раньше готовности БД и не падает с `ECONNREFUSED`. — **частично:** `depends_on: { condition: service_healthy }` применяется внутри compose (`minio-setup` → `minio`), но само приложение бежит на хосте и в compose-граф не входит, поэтому этот критерий для него не работает by design. Его роль выполняет preflight в `pnpm dev` (STORY-001-06). Контейнеры `api`/`worker` с `depends_on` появятся в [EPIC-017](../../epic-017-self-host-alpha/epic.md), в `docker-compose.prod.yml`.
- [x] **Given** профиль `minimal` (`docker compose --profile minimal up`) **When** смотрю список контейнеров **Then** Meilisearch не поднят, а Postgres, Redis и MinIO работают. *Проверено 2026-07-27: `COMPOSE_PROFILES=minimal pnpm check:services` → три `OK`, Meilisearch и Mailpit — `SKIPPED` с указанием причины, код возврата 0.*
- [x] **Given** занятый на хосте порт 5432 **When** выполняю `pnpm docker:up` **Then** используется настраиваемый через `.env` порт публикации (`POSTGRES_PORT`), и конфликт решается правкой одной переменной, а не compose-файла. *Проверено 2026-07-27 на реальном конфликте с локально установленным PostgreSQL; в compose правки одной переменной достаточно, но строки подключения в `.env` (`DATABASE_URL`, `DATABASE_MIGRATION_URL`) содержат порт отдельно и правятся тоже — это зафиксировано в `docs/runbooks/local-environment.md` §5.1.*
- [ ] **Given** запущенный MinIO **When** стартует стек **Then** init-контейнер идемпотентно создаёт бакет `bad-crm` и сервисный ключ доступа; повторный запуск не падает. — **частично:** бакет создаётся идемпотентно (`mc mb --ignore-existing`) и закрывается от анонимного доступа, повторный запуск проходит. **Отдельный сервисный ключ доступа не создаётся** — приложение ходит под root-кредами MinIO. Выделение сервисного ключа с политикой только на свой бакет перенесено в [STORY-017-03](../../epic-017-self-host-alpha/stories/story-017-03-env-and-secrets.md) (секреты и креды поставки): на ноутбуке root-креды и так известны владельцу, а на инсталляции их разделение — часть чек-листа безопасной установки, а не dev-файла.

## Задачи

- [x] Написать тест окружения `test/env/compose.test.ts`: парсит `docker-compose.yml` и проверяет — у каждого сервиса задан `healthcheck`, тег образа не `latest`, объявлен именованный том, порты берутся из переменных. *Файл живёт в `test/infra/compose.test.ts` (каталог `test/env/` оставлен под `.env`-контракт); дополнительно проверяет bind строго на `127.0.0.1`, отсутствие литеральных секретов и префикс `dev_` у дефолтов.*
- [x] Написать smoke-скрипт `scripts/check-services.ts`: подключается к Postgres (`SELECT 1` + список расширений), Redis (`PING`), MinIO (`HeadBucket`), Meilisearch (`GET /health`), Mailpit (`GET /api/v2/messages`) и печатает сводку. *Подключён как `pnpm check:services`. Сверх плана: проверяет не только расширения, но и четыре роли БД с их атрибутами (`app_user` без `BYPASSRLS`, `backup_role` с ним) — контейнерный healthcheck этого не видит; `HeadBucket` подписывается SigV4, поэтому проверяются и креды, а не только существование бакета; Mailpit проверяется по SMTP-баннеру, а не по HTTP-API — сервер приложения ходит именно в SMTP. Логика (разбор конфигурации, вердикт, коды выхода) покрыта `test/repo/service-checks.test.ts` и `test/repo/preflight.test.ts`.*
- [x] Создать `docker-compose.yml`: `postgres` (`pgvector/pgvector:pg16`), `redis` (`redis:8.x-alpine` с AOF — 7.x запрещён лицензией, см. docs/legal/licensing.md §4), `minio` (`minio/minio`), `minio-init`, `meilisearch` (`getmeili/meilisearch:v1.x`, профиль `default`), `Mailpit`. *Init-контейнер называется `minio-setup`.*
- [x] Смонтировать `packages/server/prisma/sql/` в `/docker-entrypoint-initdb.d/` — точка расширения для bootstrap-скрипта ролей из [EPIC-005](../../epic-005-multi-tenancy-rls/epic.md); в этой истории создаётся только каталог и скрипт включения расширений `01-extensions.sql`. *См. раздел «Отклонения от плана»: роли созданы раньше срока.*
- [x] Добавить профили `minimal` и `default`, распределив сервисы по ним согласно [`stack.md`](../../../docs/architecture/stack.md).
- [x] Добавить корневые скрипты `docker:up` (с `--wait`), `docker:down`, `docker:reset` (удаление томов с подтверждением), `docker:logs`.
- [x] Прописать в `docs/runbooks/local-environment.md` порядок диагностики: какой контейнер за что отвечает, как посмотреть логи, как сбросить том. *Раннбук написан: карта сервисов и портов, логи, сброс томов, ручное подключение к каждому из пяти сервисов, семь типовых проблем с диагностикой и лечением, протокол и результат замера холодного старта. Связан с `install.md` и `backup-restore.md`, добавлен в `docs/README.md`.*

## Отклонения от плана

- **Bootstrap-роли БД сделаны раньше плана.** Задача выше откладывала `00-bootstrap-roles.sql` на [EPIC-005](../../epic-005-multi-tenancy-rls/epic.md), оставляя здесь только каталог и `01-extensions.sql`. Реализация создала роли (`app_migrator`, `app_user`, `app_auth`, `backup_role`) уже в этой истории.
  **Обоснование:** роли нужны до первой миграции, а не после неё. `DATABASE_URL` и `DATABASE_MIGRATION_URL` из STORY-001-05 указывают на разные роли, и `.env.example` обязан их описать; если первая миграция пройдёт под суперпользователем, владельцем таблиц станет он, и последующее `FORCE ROW LEVEL SECURITY` будет применено к схеме, которую придётся переливать. Инициализация ролей возможна только при первом старте контейнера Postgres — отложить её значит требовать `docker:reset` со сносом тома у каждого, кто уже поднял стек.
  **Что осталось за EPIC-005:** сами политики RLS, `withTenant`/`guardedClient`, isolation-тесты с положительным контролем. Здесь создан только фундамент ролей и грантов.

## Definition of Done

- [x] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [x] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [x] Документация обновлена (docs/ + запись в `docs/brain/`)
- [x] a11y-проверка (для UI-историй) — не применимо
- [x] i18n: строки в обоих языках, хардкода нет (для UI-историй) — не применимо

> **Статус `done` при двух незакрытых acceptance-критериях.** Оба не выполнены не потому, что работа
> не сделана, а потому, что предмет проверки принадлежит другому эпику: `depends_on` для контейнера
> приложения существует только в `docker-compose.prod.yml` ([EPIC-017](../../epic-017-self-host-alpha/epic.md)),
> отдельный сервисный ключ MinIO — часть модели секретов поставки
> ([STORY-017-03](../../epic-017-self-host-alpha/stories/story-017-03-env-and-secrets.md)). Оба
> перенесены явно, с ссылками. Всё, что эта история обещала для dev-стека, проверено на живом стеке
> в обоих профилях.

## Ссылки

- Документация: [`stack.md` → Требования к среде](../../../docs/architecture/stack.md), [`overview.md` → Развёртывание](../../../docs/architecture/overview.md), [`prd.md` → NFR-3, риск R-14](../../../docs/product/prd.md)
- Правила: `rules/dependencies.mdc`, `rules/security.mdc`
