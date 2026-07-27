---
id: EPIC-003
title: Скелет сервера и контракт API
status: review
blocked: false
milestone: M1
owner: unassigned
created: 2026-07-26
---

# EPIC-003 — Скелет сервера и контракт API

## Зачем (ценность)

Все 18 доменов ТЗ будут писаться по одному шаблону: контроллер валидирует вход, вызывает один
use-case, сериализует ответ; домен не знает про Prisma и Express; ошибки летят до единого
обработчика; контракт API — файл `openapi.yaml`, а не то, что случайно получилось в коде. Эпик
создаёт этот шаблон целиком и доказывает его одним сквозным сценарием (health), чтобы каждая
следующая функция добавлялась копированием проверенной структуры, а не изобретением новой.

## Scope

### В скоупе

- Express 5 приложение, `main.ts` как composition root, graceful shutdown с жёстким таймаутом.
- Каркас гексагональной архитектуры (`domain` / `application` / `infrastructure` / `presentation`) и один сквозной use-case через port + adapter.
- Структурные логи pino, `requestId` и контекст через `AsyncLocalStorage`, типизированный `AppError`, единый error-handler.
- Zod-валидация `params`/`query`/`body` и ответы ошибок в формате `application/problem+json` (RFC 9457).
- `docs/api/openapi.yaml` как source of truth + `pnpm api:gen` (openapi-typescript) с проверкой пустого diff в CI.
- Инициализация Prisma, первая миграция, интеграционный харнесс на Testcontainers.
- Двусторонний контрактный тест: роутер ↔ спецификация.

### Вне скоупа

- Мультиарендность, `organizationId` и RLS — [EPIC-005](../epic-005-multi-tenancy-rls/epic.md).
- Аутентификация, сессии, refresh — [EPIC-006](../epic-006-auth-core/epic.md).
- Метрики, трассировка, `/ready` с проверкой зависимостей — [EPIC-009](../epic-009-observability/epic.md) (здесь только базовый `/health` и заготовка порта логирования).
- Очереди BullMQ и transactional outbox — [EPIC-025](../epic-025-realtime-infrastructure/epic.md) / профильные эпики (здесь только объявляется `OutboxPort` без реализации).

## Acceptance (эпик выполнен, когда)

- [ ] `pnpm --filter @bad-crm/server dev` поднимает Express 5 приложение; `GET /health` отвечает 200 и проходит по всей цепочке контроллер → use-case → порт → адаптер.
- [ ] `SIGTERM` приводит к graceful shutdown: новые запросы не принимаются, in-flight завершаются, соединения закрываются; при превышении 30 с процесс завершается принудительно с кодом 1.
- [ ] Каждая запись лога содержит `requestId`, `route`, `statusCode`, `durationMs`; заголовок `x-request-id` возвращается клиенту; секреты в логах редактируются.
- [ ] Любая ошибка приложения отдаётся как `application/problem+json` со стабильным `code` из каталога `packages/shared`; необработанные исключения не текут наружу деталями стека.
- [ ] Невалидное тело запроса даёт 422 `validation_failed` со списком `errors[]`, где `path` указывает на конкретное поле.
- [ ] `pnpm api:gen` не создаёт diff в CI; типы клиента сгенерированы из `openapi.yaml`.
- [ ] Контрактный тест падает, если появился route без операции в спецификации или операция без route (кроме явного allow-list `/health`, `/ready`, `/metrics`, `/socket.io`).
- [ ] Интеграционные тесты поднимают Postgres 16 + pgvector в Testcontainers, применяют миграции и выполняются в CI.
- [ ] Архитектурные запреты проверены тестами: `domain` не импортирует Prisma/Express, `application` не импортирует `infrastructure`, контроллер не обращается к репозиторию.

## Зависимости / риски

- Зависит от: [EPIC-001](../epic-001-monorepo-and-dev-env/epic.md) (монорепо, env-схема, docker-стек).
- Блокирует: [EPIC-004](../epic-004-client-shell-fsd/epic.md) (типы клиента из спеки), [EPIC-005](../epic-005-multi-tenancy-rls/epic.md), [EPIC-006](../epic-006-auth-core/epic.md), [EPIC-009](../epic-009-observability/epic.md).
- Риски: расхождение спецификации и кода — митигируется двусторонним контрактным тестом; **R-10** (опасные миграции) — здесь закладывается шаблон миграции и подключается `db-reviewer`. Ветка Express — **5.x**, решение уже принято и зафиксировано в [ADR-0002](../../docs/architecture/adr/0002-hexagonal-backend-express-prisma.md); [`roadmap.md`](../../docs/product/roadmap.md) и [`prd.md`](../../docs/product/prd.md) описывают этот эпик так же (прежняя формулировка «в `roadmap.md` упоминается Express 4» устарела, *приведено в соответствие 2026-07-26*). Практическое следствие для реализации: в Express 5 async-ошибки пробрасываются в error-handler автоматически, поэтому обёртки `asyncHandler` не нужны и их наличие в коде — дефект (проверяется архитектурным тестом в STORY-003-01).

## Ссылки

- Документация: [`stack.md` → Backend: гексагональная архитектура](../../docs/architecture/stack.md), [`stack.md` → Контракт API](../../docs/architecture/stack.md), [`overview.md` → C4 уровень 3](../../docs/architecture/overview.md), [ADR-0002](../../docs/architecture/adr/0002-hexagonal-backend-express-prisma.md), [ADR-0003](../../docs/architecture/adr/0003-openapi-as-source-of-truth.md)
- Правила: `rules/api-contract.mdc`, `rules/naming-and-structure.mdc`, `rules/testing.mdc`

## Истории

- [ ] [STORY-003-01 — Express 5 приложение, composition root, graceful shutdown](stories/story-003-01-express-app-composition-root.md)
- [ ] [STORY-003-02 — Гексагональный скелет и сквозной health use-case](stories/story-003-02-hexagonal-skeleton-health-use-case.md)
- [ ] [STORY-003-03 — Логи pino, requestId, AppError и error-handler](stories/story-003-03-logging-request-context-app-error.md)
- [ ] [STORY-003-04 — Zod-валидация границ и формат problem+json](stories/story-003-04-zod-validation-problem-json.md)
- [ ] [STORY-003-05 — openapi.yaml как source of truth и генерация типов](stories/story-003-05-openapi-contract-and-codegen.md)
- [ ] [STORY-003-06 — Prisma, первая миграция и харнесс Testcontainers](stories/story-003-06-prisma-init-and-testcontainers-harness.md)
- [ ] [STORY-003-07 — Двусторонний контрактный тест роутер ↔ спецификация](stories/story-003-07-openapi-route-contract-test.md)
