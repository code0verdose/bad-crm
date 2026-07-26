---
id: STORY-009-04
epic: EPIC-009
status: backlog
blocked: false
priority: should
estimate: M
---

# STORY-009-04 — OpenTelemetry-трейсы

**Как** администратор системы **я хочу** при необходимости включить распределённые трейсы
**чтобы** видеть, где именно уходит время медленного запроса, и при этом не платить за это
ресурсами на маленькой инсталляции.

## Acceptance (Given/When/Then)

- **Given** пустой `OTEL_EXPORTER_OTLP_ENDPOINT` **When** приложение стартует **Then** трассировка не инициализируется, spans не создаются, накладных расходов нет; логи и метрики работают.
- **Given** заданный `OTEL_EXPORTER_OTLP_ENDPOINT` **When** приложение обрабатывает запрос **Then** создаётся span HTTP-запроса с вложенными spans Express-маршрута, запросов Prisma и обращений к Redis.
- **Given** активный span **When** пишется строка лога **Then** в ней присутствует `traceId`, а в span-атрибутах — `requestId`: из лога можно перейти в трейс и обратно.
- **Given** span запроса к БД **When** он экспортируется **Then** в атрибутах нет значений параметров запроса и персональных данных — только имя операции и модель.
- **Given** production **When** применяется сэмплирование **Then** используется `parentbased_traceidratio` 10 %, в dev — 100 %; значение настраивается переменной окружения.
- **Given** недоступный OTLP-коллектор **When** приложение работает **Then** экспорт ошибок логируется с ограничением частоты и не влияет на обработку запросов; приложение не падает.
- **Given** фоновая задача **When** она выполняется **Then** её span связан с исходным HTTP-запросом через контекст, перенесённый в payload задачи.

## Задачи

- [ ] Написать тесты первыми: `test/unit/tracing/disabled-by-default.test.ts` (без переменной SDK не стартует), `test/integration/tracing/spans.test.ts` (структура spans через in-memory экспортёр), `test/unit/tracing/attributes.test.ts` (нет параметров запросов и персональных данных).
- [ ] Реализовать `infrastructure/tracing/otel.ts` — инициализация Node SDK с автоинструментацией `http`, `express`, `@prisma/instrumentation`, `ioredis`, выполняемая до создания клиентов.
- [ ] Реализовать условную инициализацию по наличию `OTEL_EXPORTER_OTLP_ENDPOINT` и настройку сэмплера через env.
- [ ] Добавить `traceId` в контекст логирования (mixin pino) и `requestId` в атрибуты span.
- [ ] Настроить фильтрацию атрибутов, исключающую параметры SQL и чувствительные поля.
- [ ] Перенести контекст трассировки в payload фоновых задач и восстанавливать его в `runJob`.
- [ ] Добавить корректное завершение SDK в graceful shutdown (flush перед выходом).
- [ ] Задокументировать включение трассировки и пример коллектора в `docs/runbooks/observability.md`.

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y-проверка (для UI-историй) — не применимо
- [ ] i18n: строки в обоих языках, хардкода нет (для UI-историй) — не применимо

## Ссылки

- Документация: [`stack.md` → Трейсы](../../../docs/architecture/stack.md), [`prd.md` → NFR-9 (автономность от внешних SaaS)](../../../docs/product/prd.md)
- Правила: `rules/observability.mdc`, `rules/security.mdc`
