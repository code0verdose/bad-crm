---
date: 2026-07-27
project: bad-crm
tags: [Express, TypeScript, Zod, pino, helmet, CORS, ULID, Vitest, supertest, hexagonal architecture, AsyncLocalStorage, RFC 9457, CSP]
---

# EPIC-003 (истории 01–03) — скелет сервера: Express 5, гексагональные слои, логи и ошибки

## Простым языком

1. **Сервер теперь реально стартует и останавливается.** `main.ts` — три строки; вся
   последовательность старта (проверить конфигурацию → собрать логгер → собрать зависимости →
   открыть порт) вынесена в отдельный модуль, чтобы её можно было проверить тестами. Зачем: порядок
   тут — не косметика, а гарантия того, что процесс с битым `.env` **не начнёт** принимать запросы,
   которые не сможет обслужить.

2. **Остановка по `SIGTERM` не рвёт запросы.** Сначала сервер перестаёт считаться «готовым» (чтобы
   балансировщик увёл трафик), потом перестаёт принимать соединения, дожидается текущих запросов,
   закрывает ресурсы и выходит с кодом 0. Через 30 секунд — принудительный выход с кодом 1 и строкой
   в логе. Повторный сигнал ничего не запускает второй раз. Зачем: иначе каждый деплой — это пачка
   оборванных запросов у живых пользователей.

3. **Появился образец, по которому пишутся все следующие домены.** Health-проверка проходит весь
   путь: контроллер → use-case → порт → адаптер. Ни один слой не знает о соседях больше, чем должен,
   и это проверяется тестами, а не на ревью.

4. **`/health` и `/ready` — разные вещи.** Первый отвечает «процесс жив» и ничего не спрашивает у
   зависимостей; второй отвечает «можно слать трафик» и учитывает состояние остановки и выключенные
   опциональные сервисы. Зачем: если liveness начнёт зависеть от базы, медленный запрос будет
   выглядеть как зависший контейнер, и его перезапустят — ровно в тот момент, когда это хуже всего.

5. **Логи структурные, с одним идентификатором на весь запрос.** `requestId` возвращается клиенту
   заголовком и стоит в каждой строке лога; секреты вырезаются; тела запросов и URL не логируются
   вовсе. Зачем: по одной строке из жалобы пользователя восстанавливается весь путь запроса — и при
   этом в логах нельзя найти пароль или токен.

6. **Все ошибки отдаются в одном формате** (`application/problem+json`) со стабильным кодом. Отказ в
   доступе к чужой организации отдаётся как 404, и выбор между 404 и 403 сделан один раз в
   `denyAccess(...)`, а не на каждом `throw`.

7. **Нашли и исправили два дефекта, которые тест на «заголовок есть» не ловит:** политика CSP без
   `'wasm-unsafe-eval'` не даёт открыться будущему хранилищу паролей, а `pino-http` писал в итоговую
   строку лога значения *до* маршрутизации — статус 200 у запроса, который вернул 404.

## Технически

1. `packages/server/src/main.ts:14` — точка входа в три строки; композиция вынесена в
   `infrastructure/bootstrap/api-process.factory.ts` (сеамы `loadEnvironment`/`createLogger`/`listen`/
   `onSignal`/`exit`/`reportFatal`), поэтому порядок старта покрыт `test/unit/bootstrap/api-process.test.ts`.
   Проверено вживую: `node dist/main.js` с битыми `PORT`/`APP_ENCRYPTION_KEY` печатает обе проблемы и
   выходит с кодом 1 **до** `listen`.

2. `infrastructure/bootstrap/shutdown.factory.ts` — `createShutdownHandler`: `beginShutdown()`
   синхронно → `server.close()` → закрытие `shutdownSteps` → `exit(0)`; `setTimeout(...).unref()` на
   30 000 мс → `FORCED_SHUTDOWN_MESSAGE` + `exit(1)`; идемпотентность через `running ??= run(signal)`.
   В комментарии зафиксировано требование к образу: exec-форма `CMD` (в shell-форме PID 1 — `/bin/sh`,
   который сигнал не пересылает) и `init: true` для reaping.

3. Слои: `domain/shared/errors/{app.errors.ts,access-denial.util.ts}`,
   `application/platform/{ports,use-cases}`, `infrastructure/{platform,logging,bootstrap}`,
   `presentation/http/{controllers,serializers,middleware}`. Направление зависимостей проверяется
   `test/unit/architecture/layers.test.ts` (единственное исключение — `infrastructure/bootstrap` как
   composition root), имена — `naming.test.ts`, конвенции Express 5 — `express-conventions.test.ts`
   (нет `asyncHandler`, нет `try/catch` в контроллерах, нет безымянных wildcard).

4. `presentation` не импортирует `infrastructure`: контекст запроса объявлен как
   `application/platform/ports/request-context.port.ts`, реализация — `AsyncRequestContextAdapter`
   на `AsyncLocalStorage`; `pino-http`-middleware собирается в `infrastructure/logging` и передаётся
   в `createHttpServer` как `RequestHandler`.

5. `infrastructure/logging/pino-logger.adapter.ts` — единственный вызов `pino()`: `redact` по путям
   из `log-redaction.constant.ts`, сериализатор ошибок вырезает `config.headers`, `mixin` подмешивает
   контекст. `http-logger.middleware.ts` использует `customSuccessObject`/`customErrorObject` вместо
   `customProps` — измерено на живом процессе: `customProps` вычисляется дважды и оставлял в строке
   дублирующиеся ключи `"route":"unmatched","statusCode":200` перед настоящими значениями.

6. `presentation/http/content-security-policy.util.ts` — политика собирается приложением
   ([ADR-0023](../architecture/adr/0023-csp-for-wasm-crypto.md)): `'wasm-unsafe-eval'` в `script-src`,
   origin S3 из `S3_ENDPOINT` в `connect-src`/`img-src`, COEP не выставляется, `frameguard: deny`
   (helmet по умолчанию даёт `SAMEORIGIN`, что противоречит `frame-ancestors 'none'`).

7. `packages/shared/src/errors/error-code.enums.ts` — добавлены `route_not_found` (404) и
   `payload_too_large` (413): транспортные отказы, у которых нет ресурса; таблица в
   [`stack.md`](../architecture/stack.md) обновлена.

8. `infrastructure/bootstrap/load-env.util.ts` — двухпроходный разбор окружения: Zod пропускает
   `superRefine`, если поле упало **фатально** (enum, coercion), поэтому `PORT=abc` в проде скрывал
   нарушение правила про `https` в `APP_URL`. Второй проход (`parseKnownEnvFields` +
   `crossFieldEnvIssues`) объединяет списки и убирает дубли; поведение измерено, а не предположено.

9. Зависимости (latest stable, лицензии MIT): `express@^5.2.1`, `helmet@^8.3.0`, `cors@^2.8.6`,
   `cookie-parser@^1.4.7`, `pino@^10.3.1`, `pino-http@^11.0.0`, `ulid@^3.0.2`, `supertest@7.2.2`.
   `pino` 10.x вместо 9.x из таблицы стека — `pino-http@11` требует `pino@^10`; строка в `stack.md`
   приведена в соответствие.

10. Тесты: 257 в `packages/server` (unit — domain/application/logging/bootstrap/architecture,
    integration — supertest по `/health`, `/ready`, заголовкам, CORS, 413, 404, error-handler и один
    тест с реальным сокетом). Покрытие 98.15 % строк / 95.48 % ветвей при порогах 85/80;
    `coverage-baseline.json` обновлён осознанно (ветви 100 → 95.48: прежние 100 % достигались на
    пакете из четырёх файлов).

## Применённые технологии

- [[Express]] — HTTP-слой, ветка 5.x: async-ошибки доходят до error-handler сами.
- [[pino]] — структурные логи, `redact`, `mixin` из `AsyncLocalStorage`.
- [[helmet]] — заголовки безопасности, CSP собирается приложением.
- [[Zod]] — схема окружения и граница валидации.
- [[Vitest]] + [[supertest]] — unit и HTTP-integration уровни.
- [[ULID]] — `requestId`, сортируемый по времени.
- [[Hexagonal Architecture]] — ports & adapters, composition root без DI-контейнера.

## Связи

- Проект: [[Projects/bad-crm]]
- Эпик: `epics/epic-003-server-skeleton-and-api-contract/` (истории 01–03)
- Related: [[2026-07-27--epic-001-monorepo-foundation]], [[2026-07-27--epic-002-ci-and-gates]]
- Документы: [`docs/architecture/backend-context-template.md`](../architecture/backend-context-template.md),
  [`docs/runbooks/tracing-a-request.md`](../runbooks/tracing-a-request.md),
  [ADR-0002](../architecture/adr/0002-hexagonal-backend-express-prisma.md),
  [ADR-0023](../architecture/adr/0023-csp-for-wasm-crypto.md)
