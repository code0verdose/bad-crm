---
id: STORY-009-03
epic: EPIC-009
status: backlog
blocked: false
priority: should
estimate: M
---

# STORY-009-03 — prom-client, /metrics и RED-метрики

**Как** администратор системы **я хочу** метрики частоты, ошибок и длительности запросов **чтобы**
видеть деградацию до жалоб пользователей и подтверждать соблюдение целевых p95.

## Acceptance (Given/When/Then)

- **Given** обработанный запрос **When** смотрю `/metrics` **Then** увеличен счётчик `http_requests_total{method,route,status}` и записана гистограмма `http_request_duration_seconds{method,route}`.
- **Given** запрос к `/api/v1/tasks/550e8400-…` **When** пишется метрика **Then** значение метки `route` — шаблон `/api/v1/tasks/:id`, а не URL с идентификатором; тест проверяет отсутствие взрыва кардинальности.
- **Given** endpoint `/metrics` **When** к нему обращается анонимный клиент **Then** доступ закрыт (basic-auth из конфигурации либо ограничение по сети); открытие метрик наружу без защиты невозможно по умолчанию.
- **Given** работающий процесс **When** смотрю `/metrics` **Then** присутствуют дефолтные метрики Node (heap, лаг event loop, GC) и метрики пула БД (`db_pool_active`, `db_pool_idle`).
- **Given** будущие очереди **When** смотрю каталог метрик **Then** имена `bullmq_jobs_total`, `bullmq_job_duration_seconds`, `bullmq_queue_depth`, `outbox_lag_seconds` зарезервированы и задокументированы (регистрируются соответствующими эпиками).
- **Given** метрика ошибок аутентификации **When** срабатывает rate limiting **Then** увеличивается `auth_rate_limited_total{endpoint}`.
- **Given** отключённые метрики (`METRICS_ENABLED=false`) **When** приложение работает **Then** endpoint отсутствует и накладных расходов нет.
- **Given** содержимое метрик **When** его читают **Then** в метках нет персональных данных, email, идентификаторов пользователей и организаций.

## Задачи

- [ ] Написать тесты первыми: `test/integration/metrics/http-metrics.test.ts` (счётчик и гистограмма, шаблон маршрута в метке), `test/integration/metrics/access.test.ts` (закрытый доступ), `test/unit/metrics/labels.test.ts` (нет персональных данных и высокой кардинальности).
- [ ] Реализовать `infrastructure/metrics/prom-client.adapter.ts` под портом `MetricsPort` с реестром и дефолтными метриками.
- [ ] Реализовать middleware сбора HTTP-метрик с извлечением шаблона маршрута Express.
- [ ] Реализовать контроллер `GET /metrics` с basic-auth из конфигурации и добавить его в allow-list контрактного теста.
- [ ] Зарегистрировать метрики пула БД и зарезервировать имена метрик очередей и outbox в общем каталоге `infrastructure/metrics/registry.ts`.
- [ ] Добавить переменную `METRICS_ENABLED` (и креды) в env-схему и `.env.example`.
- [ ] Задокументировать каталог метрик и пример конфигурации Prometheus в `docs/runbooks/observability.md`.

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y-проверка (для UI-историй) — не применимо
- [ ] i18n: строки в обоих языках, хардкода нет (для UI-историй) — не применимо

## Ссылки

- Документация: [`stack.md` → Метрики](../../../docs/architecture/stack.md), [`prd.md` → NFR-2](../../../docs/product/prd.md)
- Правила: `rules/observability.mdc`, `rules/security.mdc`
