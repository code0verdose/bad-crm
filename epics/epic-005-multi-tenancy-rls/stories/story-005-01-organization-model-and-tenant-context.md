---
id: STORY-005-01
epic: EPIC-005
status: review
blocked: false
priority: must
estimate: M
---

# STORY-005-01 — Модель Organization, миграция и tenant-контекст

**Как** разработчик Bad CRM **я хочу** корневую сущность арендатора и механизм переноса
`organizationId` через все слои без передачи параметром **чтобы** каждый запрос к БД выполнялся в
контексте ровно одного арендатора, и это нельзя было забыть.

## Acceptance (Given/When/Then)

- [x] **Given** миграция с таблицей `organizations` **When** она применена **Then** есть `id uuid PK`, `slug` с глобально уникальным индексом, `name`, `settings jsonb`, `timezone`, `default_currency`, `created_at`, `updated_at`, `deleted_at?`; частичный индекс `WHERE deleted_at IS NULL`. — сделано в [STORY-003-06](../../epic-003-server-skeleton-and-api-contract/stories/story-003-06-prisma-init-and-testcontainers-harness.md). *Колонка `plan` из формулировки убрана: [`data-model.md`](../../../docs/architecture/data-model.md) («Биллинг самого продукта в 1.0 не моделируется») прямо говорит, что её в схеме нет — тарифы Bad CRM в Won't-списке PRD. Ошибка была в тексте истории, а не в реализации.*
- [x] **Given** попытка создать вторую организацию с тем же `slug` **When** выполняется вставка **Then** нарушается уникальный индекс и возвращается 409 `organization_already_exists`, а не 500. *Реализовано здесь: `TenantScopedRepository` переводит `P2002` в `ConflictError('organization_already_exists')` (409 берётся из каталога кодов). Проверено на живой БД — `test/integration/db/organization-bootstrap.test.ts` → «reports a taken slug as a conflict». HTTP-вход появится в [STORY-006-01](../../epic-006-auth-core/stories/story-006-01-organization-and-owner-registration.md).*
- [x] **Given** HTTP-запрос с установленным контекстом арендатора **When** обработчик вызывает вложенные функции любой глубины **Then** `getTenantContext()` возвращает тот же `organizationId` без передачи параметром. — сделано в [STORY-003-06](../../epic-003-server-skeleton-and-api-contract/stories/story-003-06-prisma-init-and-testcontainers-harness.md) (`currentTenant()` / `requireTenant()`).
- [x] **Given** два одновременно обрабатываемых запроса разных организаций **When** оба выполняют операции с БД **Then** контексты не смешиваются: тест с искусственной задержкой между установкой контекста и запросом подтверждает изоляцию `AsyncLocalStorage`. *Теста не было — добавлен здесь: `test/unit/persistence/tenant-context.test.ts` → «keeps the contexts of two concurrent scopes apart». Задержка обязательна: без неё первый скоуп закрывается раньше открытия второго, и тест проходит даже на общей переменной модуля.*
- [x] **Given** попытка обратиться к данным арендатора вне контекста **When** вызывается репозиторий **Then** бросается ошибка `Tenant context is missing for <model>.<operation>`, запрос в БД не уходит. — сделано в [STORY-003-06](../../epic-003-server-skeleton-and-api-contract/stories/story-003-06-prisma-init-and-testcontainers-harness.md) (`guardedClient`); здесь распространено на репозитории — `TenantScopedRepository.run` спрашивает `requireTenant` до отправки запроса.
- [ ] **Given** `organizationId` в запросе **When** формируется контекст **Then** он берётся **только** из сессии, а не из заголовка `Host`, поддомена или тела запроса — покрыто тестом с подделанными заголовками. — **перенесено в [STORY-006-05](../../epic-006-auth-core/stories/story-006-05-client-session-bootstrap-and-guards.md)**: сессии не существует, брать контекст неоткуда. Middleware «из тестового провайдера» — это ровно та заглушка, которую запрещает `rules/commit-hygiene.mdc`, а тест «контекст не берётся из `Host`» без единого места, которое его формирует, проверял бы отсутствие кода.
- [ ] **Given** фоновый job **When** он обрабатывает событие **Then** обёртка `runJob` устанавливает контекст из `organizationId` в payload; job без этого поля отклоняется как невалидный. — **перенесено в [EPIC-025](../../epic-025-realtime-infrastructure/epic.md)/очереди**: BullMQ и outbox в проекте ещё нет, обёртывать нечего. Контракт зафиксирован в [`rls-design.md`](../../../docs/security/rls-design.md), «Особые пути», путь 3.

## Задачи

- [x] Написать тесты первыми: `test/unit/tenant/tenant-context.test.ts` (вложенность, изоляция параллельных контекстов, ошибка вне контекста), `test/integration/db/organizations.test.ts` (миграция, уникальность slug, частичный индекс), `test/unit/tenant/source-of-truth.test.ts` (контекст не берётся из Host/поддомена/тела). *Файлы живут по фактическим путям: `test/unit/persistence/tenant-context.test.ts` и `test/integration/db/{migrations,tenant-context}.test.ts` — каталог `tenant/` не заводился, персистентность лежит в `persistence/`. Тест параллельных контекстов добавлен здесь. `source-of-truth.test.ts` — вместе с сессией, см. перенесённый критерий выше.*
- [x] Добавить модель `Organization` в `packages/server/prisma/schema.prisma` согласно [`data-model.md`](../../../docs/architecture/data-model.md). — сделано в [STORY-003-06](../../epic-003-server-skeleton-and-api-contract/stories/story-003-06-prisma-init-and-testcontainers-harness.md).
- [x] Создать миграцию с таблицей, индексами и полным блоком RLS (шаблон — [STORY-005-02](story-005-02-rls-policies-and-set-config.md)); `organizations` использует особый предикат по собственному `id`. — сделано в [STORY-003-06](../../epic-003-server-skeleton-and-api-contract/stories/story-003-06-prisma-init-and-testcontainers-harness.md) (`20260727120000_init_tenancy_and_rls`).
- [x] Реализовать `infrastructure/persistence/prisma/tenant-context.ts`: `AsyncLocalStorage<{ ctx: TenantContext; tx }>`, `getTenantContext()`, тип `TenantContext { organizationId, userId, bypassRls? }`. — сделано в [STORY-003-06](../../epic-003-server-skeleton-and-api-contract/stories/story-003-06-prisma-init-and-testcontainers-harness.md), файл называется `tenant.context.ts` (role-suffix из закрытого словаря `rules/naming-and-structure.mdc`). *Поля `bypassRls` в типе нет намеренно — см. [STORY-005-03](story-005-03-tenant-scoped-repository-base.md): пока нет аудит-журнала, куда его писать, флаг был бы обходом без следа.*
- [ ] Реализовать middleware `presentation/http/middleware/tenant-context.ts`, устанавливающее контекст из сессии (интеграция с сессией — [EPIC-006](../../epic-006-auth-core/epic.md); до неё — из тестового провайдера). — **перенесено в [EPIC-006](../../epic-006-auth-core/epic.md)** вместе с критерием выше.
- [x] Дополнить контекст логирования полями `organizationId` и `userId` (связка с [STORY-003-03](../../epic-003-server-skeleton-and-api-contract/stories/story-003-03-logging-request-context-app-error.md)). — сделано в [STORY-003-03](../../epic-003-server-skeleton-and-api-contract/stories/story-003-03-logging-request-context-app-error.md): `RequestContextPort` несёт оба поля (пока `null` — заполнять их будет тот же middleware).
- [ ] Реализовать обёртку `runJob` для фоновых задач, требующую `organizationId` в payload. — **перенесено в эпик очередей**: очередей нет.
- [x] Обновить `docs/architecture/data-model.md` и `docs/security/rls-design.md`, если реализация уточняет описанное. *В `rls-design.md` добавлены разделы «База репозитория: `TenantScopedRepository`» и «Проверка роли при старте», плюс правило грантов на последовательности и два пункта чек-листа «новая таблица». `data-model.md` править не пришлось — расхождение было в тексте истории (`plan`), а не в модели.*

## Definition of Done

- [x] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [x] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [x] Документация обновлена (docs/ + запись в `docs/brain/`)
- [x] a11y-проверка (для UI-историй) — не применимо
- [x] i18n: строки в обоих языках, хардкода нет (для UI-историй) — не применимо

## Ссылки

- Документация: [`rls-design.md` → Выставление контекста из приложения](../../../docs/security/rls-design.md), [`data-model.md` → Tenancy и идентичность](../../../docs/architecture/data-model.md), [`overview.md` → (а) Tenancy и RLS](../../../docs/architecture/overview.md)
- Правила: `rules/tenancy-rls.mdc`
