---
id: STORY-003-03
epic: EPIC-003
status: review
blocked: false
priority: must
estimate: M
---

# STORY-003-03 — Логи pino, requestId, AppError и error-handler

**Как** администратор системы **я хочу** структурные логи со сквозным идентификатором запроса и
единую обработку ошибок **чтобы** по одной строке из жалобы пользователя восстанавливать весь путь
запроса и не находить в логах пароли и токены.

## Acceptance (Given/When/Then)

- **Given** входящий запрос без заголовка `x-request-id` **When** он обрабатывается **Then** генерируется ULID, кладётся в `AsyncLocalStorage`, возвращается клиенту в заголовке `x-request-id` и присутствует во всех строках лога этого запроса.
- **Given** входящий запрос с заголовком `x-request-id` от reverse-proxy **When** он обрабатывается **Then** используется переданное значение, а не новое.
- **Given** завершённый запрос **When** пишется итоговая строка лога **Then** в ней есть `requestId`, `route` (шаблон `/api/v1/tasks/:id`, а не URL с id), `statusCode`, `durationMs`, `organizationId` и `userId` (пока `null` — заполняются в [EPIC-006](../../epic-006-auth-core/epic.md)).
- **Given** запрос с заголовком `Authorization: Bearer …`, cookie и телом с полем `password` **When** он логируется **Then** значения заменены на `[Redacted]` по путям редактирования; поиск по логу не находит исходных значений.
- **Given** ошибка HTTP-клиента с `config.headers`, содержащими токен интеграции **When** ошибка сериализуется в лог **Then** заголовки вырезаны сериализатором ошибок.
- **Given** `AppError` с кодом `task_not_found` **When** он долетает до error-handler **Then** ответ 404 `problem+json` с этим кодом, а в лог пишется уровень `warn` без стека.
- **Given** непредвиденное исключение **When** оно долетает до error-handler **Then** клиенту уходит 500 `internal_error` без `detail` и без стека, а в лог пишется `error` со стеком и `requestId`.
- **Given** `LOG_LEVEL=info` **When** обрабатывается запрос к `/api/v1/auth/*` **Then** тело запроса не логируется ни при каком уровне.

## Задачи

- [x] Написать тесты первыми: `test/unit/logging/redaction.test.ts` (все чувствительные пути замаскированы), `test/unit/logging/request-context.test.ts` (контекст доступен во вложенных вызовах и не течёт между запросами), `test/integration/http/error-handler.test.ts` (маппинг доменных ошибок и непредвиденных исключений).
- [x] Реализовать `infrastructure/logging/request-context.ts`: `AsyncLocalStorage<RequestContext>` + `contextMiddleware` (генерация/проброс `requestId`, установка заголовка ответа).
- [x] Реализовать `infrastructure/logging/pino.adapter.ts`: `mixin` из контекста, `redact` по путям (`req.headers.authorization`, `req.headers.cookie`, `res.headers["set-cookie"]`, `*.password`, `*.token`, `*.refreshToken`, `*.apiKey`, `*.apiKeyEnc`, `*.secret`, `*.otp`, `*.recoveryCode`), сериализатор ошибок без `config.headers`.
- [x] Подключить `pino-http` с извлечением шаблона маршрута Express для поля `route`.
- [x] Реализовать типизированный `AppError` в `domain/shared/errors/` (поля `code`, `status`, `details?`) и маппинг `code → HTTP` из `packages/shared/errors/codes.ts`.
- [x] Реализовать `presentation/http/error-handler.ts`: доменные ошибки → соответствующий статус, `ZodError` → 422, всё остальное → 500 без утечки деталей; в ответ всегда добавляется `requestId`.
- [x] Добавить объявление `LoggerPort` в `application/platform/ports/` — домен и use-cases логируют через порт, а не через глобальный pino.
- [x] Зафиксировать в `docs/runbooks/` рецепт «найти всё по requestId».

> **Отклонения от формулировок задач.** Файлы названы по словарю суффиксов:
> `infrastructure/logging/async-request-context.adapter.ts` (+ `RequestContextPort` в
> `application/platform/ports/`, иначе `presentation` импортировал бы `infrastructure`),
> `infrastructure/logging/pino-logger.adapter.ts`, `presentation/http/error-handler.middleware.ts`.
> Тело запроса не логируется **вообще** (ни на каком уровне) — строже, чем требовала задача: URL и
> тело содержат секреты (`/l/:token`), поэтому pino-http сериализует только метод и статус.

## Definition of Done

- [x] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [x] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y-проверка (для UI-историй) — не применимо
- [ ] i18n: строки в обоих языках, хардкода нет (для UI-историй) — коды ошибок переводятся на клиенте, см. [EPIC-008](../../epic-008-i18n-en-ru/epic.md)

## Ссылки

- Документация: [`stack.md` → Наблюдаемость / Логи](../../../docs/architecture/stack.md), [`stack.md` → Редактирование секретов в логах](../../../docs/architecture/stack.md), [`overview.md` → (з) Observability](../../../docs/architecture/overview.md)
- Правила: `rules/observability.mdc`, `rules/security.mdc`
