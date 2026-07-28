---
id: STORY-006-07
epic: EPIC-006
status: backlog
blocked: false
priority: must
estimate: S
---

# STORY-006-07 — Rate limiting и lockout на login/refresh/reset

**Как** администратор системы **я хочу** ограничение частоты попыток аутентификации **чтобы**
перебор паролей был экономически бессмысленным, а инсталляция не падала от потока запросов.

## Acceptance (Given/When/Then)

- **Given** 5 неудачных попыток входа за 15 минут по паре IP + email **When** приходит шестая **Then** ответ 429 с заголовком `Retry-After` и кодом `rate_limited`; проверка пароля не выполняется вовсе.
- **Given** превышение лимита **When** попытки продолжаются **Then** задержка растёт экспоненциально, а не сбрасывается на каждую новую попытку.
- **Given** успешный вход **When** он произошёл **Then** счётчик неудач для этой пары обнуляется.
- **Given** две реплики приложения **When** попытки приходят на разные реплики **Then** счётчик общий: используется `rate-limiter-flexible` поверх Redis, а не память процесса.
- **Given** недоступный Redis **When** приходит запрос на логин **Then** поведение задано явно и безопасно: запросы аутентификации отклоняются с 503 (fail-closed), а не пропускаются без лимита; поведение покрыто тестом.
- **Given** регистрация организации **When** с одного IP приходит четвёртый запрос за час **Then** он отклоняется 429 (лимит 3/час).
- **Given** endpoint сброса пароля **When** для одного email запрошено больше лимита писем **Then** дальнейшие запросы отклоняются, но ответ пользователю не раскрывает существование адреса.
- **Given** сработавший лимит **When** событие фиксируется **Then** оно попадает в лог с уровнем `warn` и в метрику `auth_rate_limited_total`, без раскрытия пароля и email в открытом виде.

## Задачи

- [ ] Написать тесты первыми: `test/integration/auth/rate-limit.test.ts` (порог, `Retry-After`, сброс после успеха, экспоненциальная задержка), `test/unit/auth/limiter-fail-closed.test.ts` (поведение при недоступном Redis), `test/integration/auth/register-limit.test.ts`.
- [ ] Реализовать `infrastructure/redis/rate-limiter.adapter.ts` под портом `RateLimiterPort` на `rate-limiter-flexible`.
- [ ] Настроить наборы лимитов из [`stack.md`](../../../docs/architecture/stack.md): логин/сброс/2FA (IP+email, 5/15 мин), регистрация (IP, 3/час), общий API (userId/IP, 300/мин), тяжёлые endpoint'ы (10/мин).
- [ ] Реализовать middleware применения лимита с корректным вычислением ключа (учёт доверенных прокси при определении IP).
- [ ] Реализовать сброс счётчика при успешной аутентификации.
- [ ] Реализовать явную политику fail-closed при недоступности Redis и её логирование.
- [ ] Добавить метрику `auth_rate_limited_total{endpoint}` (подключается к [EPIC-009](../../epic-009-observability/epic.md)).
- [ ] Отразить лимиты в `docs/api/openapi.yaml` (ответ 429) и в `docs/runbooks/`.
      *(2026-07-28: **половина в спеке сделана** — 429 с обязательным `Retry-After` объявлен на
      `login`, `refresh`, `register`, `forgot-password`, `reset-password` и `change-password`.
      Отдельно добавлен ответ 503 `service_unavailable` на `login` и `refresh`: при недоступном
      Redis лимитер не может считать, а несчитаемый логин — это логин без лимита, поэтому запрос
      отклоняется (fail closed). Раздел в `docs/runbooks/` — за этой историей.)*

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y-проверка: сообщение о временной блокировке доступно скринридеру и содержит время до повтора
- [ ] i18n: строки в обоих языках, хардкода нет

## Ссылки

- Документация: [`stack.md` → Rate limiting](../../../docs/architecture/stack.md), [`prd.md` → NFR-6](../../../docs/product/prd.md), [`threat-model.md`](../../../docs/security/threat-model.md)
- Правила: `rules/security.mdc`, `rules/observability.mdc`
