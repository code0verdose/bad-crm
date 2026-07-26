---
id: STORY-009-02
epic: EPIC-009
status: backlog
blocked: false
priority: must
estimate: S
---

# STORY-009-02 — /health и /ready с проверкой зависимостей

**Как** администратор системы **я хочу** честные пробы живости и готовности **чтобы** контейнер
перезапускался при зависании и не принимал трафик, пока БД или миграции не готовы.

## Acceptance (Given/When/Then)

- **Given** работающий процесс **When** запрашиваю `GET /health` **Then** ответ 200 без единого обращения к БД, Redis или S3 — проба живости не должна падать из-за внешнего сервиса.
- **Given** недоступный Postgres **When** запрашиваю `GET /ready` **Then** ответ 503 с телом, указывающим, какая именно зависимость не готова.
- **Given** все обязательные зависимости доступны, но `MEILI_HOST` не задан **When** запрашиваю `/ready` **Then** ответ 200, а в теле `{ "meilisearch": "disabled" }` — отключённый опциональный сервис не мешает готовности.
- **Given** незавершённые миграции **When** запрашиваю `/ready` **Then** ответ 503 с признаком `migrations: pending`.
- **Given** начавшийся graceful shutdown **When** запрашиваю `/ready` **Then** ответ 503 сразу, чтобы балансировщик увёл трафик, при этом `/health` продолжает отвечать 200 до фактической остановки.
- **Given** зависший процесс (event loop заблокирован) **When** оркестратор опрашивает `/health` **Then** ответ не приходит в пределах таймаута, и контейнер перезапускается.
- **Given** `/ready` **When** он вызывается часто **Then** проверки зависимостей кешируются на короткий срок (например, 2 секунды), чтобы проба не создавала нагрузку.
- **Given** `docker-compose.yml` **When** он поднимает стек **Then** healthcheck приложения использует `/health`, а зависимые сервисы — `condition: service_healthy`.

## Задачи

- [ ] Написать тесты первыми: `test/integration/http/health.test.ts` (нет обращений к зависимостям), `test/integration/http/ready.test.ts` (каждая зависимость по отдельности недоступна → 503 с указанием; отключённый опциональный сервис → 200 `disabled`; shutdown → 503), `test/unit/health/cache.test.ts`.
- [ ] Реализовать `application/platform/use-cases/check-readiness.use-case.ts` с портами проверок (`DbProbePort`, `CachePort`, `ObjectStorageProbePort`, `SearchProbePort`, `MigrationStatusPort`).
- [ ] Реализовать адаптеры проверок: `SELECT 1`, Redis `PING`, S3 `HeadBucket`, Meilisearch `GET /health`, чтение статуса миграций.
- [ ] Реализовать контроллеры `/health` и `/ready` и добавить их в allow-list контрактного теста.
- [ ] Реализовать кеширование результата проверок и таймауты на каждую зависимость (чтобы медленный сервис не «вешал» пробу).
- [ ] Связать флаг готовности с graceful shutdown из [STORY-003-01](../../epic-003-server-skeleton-and-api-contract/stories/story-003-01-express-app-composition-root.md).
- [ ] Настроить healthcheck приложения в `docker-compose.yml` и описать пробы в `docs/runbooks/`.

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y-проверка (для UI-историй) — не применимо
- [ ] i18n: строки в обоих языках, хардкода нет (для UI-историй) — не применимо

## Ссылки

- Документация: [`stack.md` → Health-эндпоинты, Деградация при отсутствии опционального сервиса](../../../docs/architecture/stack.md), [`prd.md` → NFR-4](../../../docs/product/prd.md)
- Правила: `rules/observability.mdc`
