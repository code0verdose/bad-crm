---
id: STORY-005-01
epic: EPIC-005
status: backlog
blocked: false
priority: must
estimate: M
---

# STORY-005-01 — Модель Organization, миграция и tenant-контекст

**Как** разработчик Bad CRM **я хочу** корневую сущность арендатора и механизм переноса
`organizationId` через все слои без передачи параметром **чтобы** каждый запрос к БД выполнялся в
контексте ровно одного арендатора, и это нельзя было забыть.

## Acceptance (Given/When/Then)

- **Given** миграция с таблицей `organizations` **When** она применена **Then** есть `id uuid PK`, `slug` с глобально уникальным индексом, `name`, `plan`, `settings jsonb`, `timezone`, `default_currency`, `created_at`, `updated_at`, `deleted_at?`; частичный индекс `WHERE deleted_at IS NULL`.
- **Given** попытка создать вторую организацию с тем же `slug` **When** выполняется вставка **Then** нарушается уникальный индекс и возвращается 409 `organization_already_exists`, а не 500.
- **Given** HTTP-запрос с установленным контекстом арендатора **When** обработчик вызывает вложенные функции любой глубины **Then** `getTenantContext()` возвращает тот же `organizationId` без передачи параметром.
- **Given** два одновременно обрабатываемых запроса разных организаций **When** оба выполняют операции с БД **Then** контексты не смешиваются: тест с искусственной задержкой между установкой контекста и запросом подтверждает изоляцию `AsyncLocalStorage`.
- **Given** попытка обратиться к данным арендатора вне контекста **When** вызывается репозиторий **Then** бросается ошибка `Tenant context is missing for <model>.<operation>`, запрос в БД не уходит.
- **Given** `organizationId` в запросе **When** формируется контекст **Then** он берётся **только** из сессии, а не из заголовка `Host`, поддомена или тела запроса — покрыто тестом с подделанными заголовками.
- **Given** фоновый job **When** он обрабатывает событие **Then** обёртка `runJob` устанавливает контекст из `organizationId` в payload; job без этого поля отклоняется как невалидный.

## Задачи

- [ ] Написать тесты первыми: `test/unit/tenant/tenant-context.test.ts` (вложенность, изоляция параллельных контекстов, ошибка вне контекста), `test/integration/db/organizations.test.ts` (миграция, уникальность slug, частичный индекс), `test/unit/tenant/source-of-truth.test.ts` (контекст не берётся из Host/поддомена/тела).
- [ ] Добавить модель `Organization` в `packages/server/prisma/schema.prisma` согласно [`data-model.md`](../../../docs/architecture/data-model.md).
- [ ] Создать миграцию с таблицей, индексами и полным блоком RLS (шаблон — [STORY-005-02](story-005-02-rls-policies-and-set-config.md)); `organizations` использует особый предикат по собственному `id`.
- [ ] Реализовать `infrastructure/persistence/prisma/tenant-context.ts`: `AsyncLocalStorage<{ ctx: TenantContext; tx }>`, `getTenantContext()`, тип `TenantContext { organizationId, userId, bypassRls? }`.
- [ ] Реализовать middleware `presentation/http/middleware/tenant-context.ts`, устанавливающее контекст из сессии (интеграция с сессией — [EPIC-006](../../epic-006-auth-core/epic.md); до неё — из тестового провайдера).
- [ ] Дополнить контекст логирования полями `organizationId` и `userId` (связка с [STORY-003-03](../../epic-003-server-skeleton-and-api-contract/stories/story-003-03-logging-request-context-app-error.md)).
- [ ] Реализовать обёртку `runJob` для фоновых задач, требующую `organizationId` в payload.
- [ ] Обновить `docs/architecture/data-model.md` и `docs/security/rls-design.md`, если реализация уточняет описанное.

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y-проверка (для UI-историй) — не применимо
- [ ] i18n: строки в обоих языках, хардкода нет (для UI-историй) — не применимо

## Ссылки

- Документация: [`rls-design.md` → Выставление контекста из приложения](../../../docs/security/rls-design.md), [`data-model.md` → Tenancy и идентичность](../../../docs/architecture/data-model.md), [`overview.md` → (а) Tenancy и RLS](../../../docs/architecture/overview.md)
- Правила: `rules/tenancy-rls.mdc`
