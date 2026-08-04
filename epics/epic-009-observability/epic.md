---
id: EPIC-009
title: Наблюдаемость
status: review
blocked: false
milestone: M1
owner: unassigned
created: 2026-07-26
---

# EPIC-009 — Наблюдаемость

## Зачем (ценность)

Self-hosted продукт обслуживает не команда разработки, а администратор чужой инсталляции. У него нет
доступа к нашим дашбордам и нет возможности «посмотреть в проде» — есть только логи контейнера,
health-эндпоинты и, если он захочет, метрики. Эпик даёт тот минимум, при котором инцидент
диагностируется по данным: сквозной контекст `requestId → organizationId → userId` в каждой строке
лога, честные `/health` и `/ready`, RED-метрики, опциональные трейсы и приём клиентских ошибок — всё
без отправки данных наружу по умолчанию.

## Scope

### В скоупе

- Логи pino со сквозным контекстом и редактированием секретов (углубление [STORY-003-03](../epic-003-server-skeleton-and-api-contract/stories/story-003-03-logging-request-context-app-error.md)).
- `/health` (живость) и `/ready` (готовность с проверкой Postgres, Redis, S3, Meilisearch и статуса миграций).
- `prom-client` и `GET /metrics` с RED-набором и защитой доступа.
- OpenTelemetry-трейсы (http, express, prisma, ioredis), выключенные по умолчанию.
- Клиентский error boundary и приём фронтовых ошибок на `POST /api/v1/telemetry/client-error`.
- `AuditLoggerPort` — заготовка интерфейса и его вызовы в существующих сценариях под реализацию в [EPIC-016](../epic-016-audit-log/epic.md).

### Вне скоупа

- Сам журнал аудита (таблица, UI, фильтры, экспорт) — [EPIC-016](../epic-016-audit-log/epic.md) (M2).
- Метрики очередей и `outbox_lag_seconds` — появляются вместе с очередями в соответствующих эпиках (здесь резервируются имена метрик).
- Нагрузочные сценарии и контроль регресса p95 — [EPIC-045](../epic-045-security-hardening/epic.md) и профильные эпики.
- Внешние сервисы мониторинга (Sentry и аналоги) — не подключаются по умолчанию, self-host не шлёт данные наружу.

## Acceptance (эпик выполнен, когда)

- [x] Каждая строка лога содержит `requestId`, `organizationId`, `userId`, `route`, `statusCode`, `durationMs`; контекст протаскивается `AsyncLocalStorage`, а не аргументами.
- [x] Ни один секрет, токен, пароль, ключ провайдера или содержимое vault не попадает в логи — проверяется тестом на наборе чувствительных полей.
- [x] `/health` отвечает без обращений к зависимостям; `/ready` проверяет Postgres, Redis, S3, статус миграций и завершение shutdown, а отключённые опциональные сервисы отражаются как `disabled` и не влияют на HTTP-статус.
- [x] `GET /metrics` отдаёт RED-набор (`http_requests_total`, `http_request_duration_seconds`) c `route` из шаблона Express, а не из URL; endpoint закрыт от анонимного доступа.
- [x] Трейсы включаются только наличием `OTEL_EXPORTER_OTLP_ENDPOINT`; при выключенных трейсах накладных расходов нет; `traceId` присутствует в логах.
- [x] Необработанная ошибка React не оставляет белый экран: показывается экран восстановления, а отчёт уходит на сервер с ограничением частоты.
- [x] `AuditLoggerPort` вызывается в привилегированных сценариях M1 (регистрация, вход, отзыв сессий, смена пароля, сброс пароля) и покрыт тестами через in-memory реализацию; полнота закрыта гейтом `test/unit/audit/audit-coverage.test.ts`. Обход RLS вызывающего не имеет: явного обхода в коде нет — `guardedClient` отказывает вместо обхода, имя `rls.bypassed` зарезервировано за эпиком, который такой путь введёт.

## Зависимости / риски

- Зависит от: [EPIC-003](../epic-003-server-skeleton-and-api-contract/epic.md) (логи и контекст), [EPIC-005](../epic-005-multi-tenancy-rls/epic.md) (`organizationId` в контексте), [EPIC-004](../epic-004-client-shell-fsd/epic.md) (клиентский error boundary).
- Блокирует: [EPIC-016](../epic-016-audit-log/epic.md), [EPIC-017](../epic-017-self-host-alpha/epic.md) (health-пробы в compose), эксплуатацию инсталляций.
- Риски: утечка чувствительных данных через логи — митигируется списком путей редактирования и тестом; взрыв кардинальности метрик по id — митигируется использованием шаблона маршрута; накладные расходы трассировки на слабом хосте — митигируется выключением по умолчанию и сэмплированием 10 % в проде.

## Ссылки

- Документация: [`stack.md` → Наблюдаемость](../../docs/architecture/stack.md), [`overview.md` → (з) Observability](../../docs/architecture/overview.md), [`prd.md` → NFR-4, NFR-6](../../docs/product/prd.md), [`roadmap.md` → M1 критерий выхода](../../docs/product/roadmap.md)
- Правила: `rules/observability.mdc`, `rules/security.mdc`

## Истории

- [x] [STORY-009-01 — Логи со сквозным контекстом и редактированием секретов](stories/story-009-01-structured-logs-with-context-and-redaction.md)
- [x] [STORY-009-02 — /health и /ready с проверкой зависимостей](stories/story-009-02-health-and-ready-endpoints.md)
- [x] [STORY-009-03 — prom-client, /metrics и RED-метрики](stories/story-009-03-prometheus-metrics-red.md)
- [x] [STORY-009-04 — OpenTelemetry-трейсы](stories/story-009-04-opentelemetry-tracing.md)
- [x] [STORY-009-05 — Клиентский error boundary и отправка ошибок](stories/story-009-05-client-error-boundary-and-reporting.md)
- [x] [STORY-009-06 — AuditLoggerPort как заготовка под журнал аудита](stories/story-009-06-audit-logger-port-stub.md)
