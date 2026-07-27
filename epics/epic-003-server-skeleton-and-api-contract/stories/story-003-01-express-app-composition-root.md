---
id: STORY-003-01
epic: EPIC-003
status: review
blocked: false
priority: must
estimate: M
---

# STORY-003-01 — Express 5 приложение, composition root, graceful shutdown

**Как** администратор системы **я хочу** чтобы приложение стартовало предсказуемо и останавливалось
без потери запросов **чтобы** обновление инсталляции сводилось к рестарту контейнера, а не к
разбору обрывов у пользователей.

## Acceptance (Given/When/Then)

- **Given** валидное окружение **When** запускаю `node dist/main.js` **Then** порядок старта строго: `loadEnv()` → логгер → инфраструктурные клиенты → `buildContainer()` → `app.listen(PORT)`; ошибка на любом шаге приводит к завершению процесса с кодом 1 и одной понятной строкой в логе.
- **Given** запущенный сервер, обрабатывающий длинный запрос **When** процесс получает `SIGTERM` **Then** сервер перестаёт принимать новые соединения, флаг готовности переводится в `false`, in-flight запрос дорабатывается и отвечает 200, после чего закрываются Prisma и Redis, а процесс завершается кодом 0.
- **Given** зависший обработчик **When** с момента `SIGTERM` прошло 30 секунд **Then** процесс завершается принудительно с кодом 1 и записью в лог `forced shutdown after timeout`.
- **Given** повторный `SIGTERM`/`SIGINT` во время остановки **When** сигнал приходит второй раз **Then** повторная процедура не запускается (идемпотентность shutdown).
- **Given** асинхронный обработчик, бросающий исключение **When** запрос обрабатывается **Then** в Express 5 ошибка сама доходит до error-handler и отдаётся как `problem+json`; обёртка `asyncHandler` в коде отсутствует (проверяется тестом на её отсутствие).
- **Given** тело запроса больше 1 МБ **When** оно приходит на любой endpoint **Then** возвращается 413 со стабильным кодом ошибки; файлы через API не загружаются по определению.
- **Given** запрос с чужого origin **When** CORS настроен на allow-list из `APP_URL` **Then** запрос отклоняется; `origin: true` в конфигурации отсутствует.
- **Given** запущенный сервер **When** смотрю заголовки ответа **Then** установлены helmet-заголовки (CSP без `unsafe-inline` для скриптов, `X-Content-Type-Options`, `Referrer-Policy`, `frame-ancestors 'none'`).

## Задачи

- [x] Написать тесты первыми: `test/integration/http/bootstrap.test.ts` (старт приложения через supertest, 200 на `/health`), `test/unit/shutdown.test.ts` (последовательность шагов, идемпотентность, таймаут), `test/unit/http-hardening.test.ts` (заголовки, лимит тела, CORS allow-list).
- [x] Реализовать `packages/server/src/presentation/http/server.ts`: `createHttpServer(container)` — helmet, cors, cookie-parser, `express.json({ limit: '1mb' })`, монтирование `routes.ts`, error-handler последним.
- [x] Реализовать `packages/server/src/main.ts` как composition root: загрузка env, создание логгера/Prisma/Redis, `buildContainer`, `listen`, регистрация обработчиков сигналов.
- [x] Реализовать `packages/server/src/infrastructure/bootstrap/shutdown.ts`: `createShutdownHandler({ server, container, timeoutMs: 30_000 })` с идемпотентностью и принудительным выходом.
- [x] Реализовать `packages/server/src/infrastructure/bootstrap/container.ts` — явная сборка зависимостей функциями, без DI-фреймворка и декораторов.
- [x] Добавить флаг готовности (`setReady`) как разделяемое состояние для `/ready` (полная реализация — [EPIC-009](../../epic-009-observability/epic.md)).
- [x] Написать архитектурный тест: в `src/**` нет `asyncHandler`-обёрток и нет `try/catch` вокруг вызова use-case в контроллерах.
- [x] **Ошибки конфигурации приходят двумя волнами.** В Zod 4 `superRefine` не выполняется, если провалился разбор хотя бы одного поля. При `.env`, где одновременно битый `APP_ENCRYPTION_KEY` и `MEILI_HOST` без `MEILI_MASTER_KEY`, оператор получает только первую проблему, чинит её, перезапускает — и лишь тогда узнаёт про вторую. Для инсталляции, которую поднимают один раз, это превращает пятиминутную настройку в перебор. Хуже того, комментарий над `serverEnvSchema` в [`packages/server/src/infrastructure/bootstrap/env.schema.ts`](../../../packages/server/src/infrastructure/bootstrap/env.schema.ts) обещает ровно обратное («a single parse reports *every* problem at once»), то есть код документирует поведение, которого у него нет. **Сделано, когда:** ошибка поля и нарушение cross-field-правила приходят одним списком (двухэтапный разбор с объединением issue либо вынос cross-field-проверок из `superRefine`); тест на комбинацию «битый `APP_ENCRYPTION_KEY` + `MEILI_HOST` без ключа» ожидает **обе** записи; комментарий приведён в соответствие с фактическим поведением. *(технический долг EPIC-001, зафиксирован 2026-07-27)*
- [x] ADR о выборе ветки Express 5 заводить не нужно — решение уже зафиксировано в [ADR-0002](../../../docs/architecture/adr/0002-hexagonal-backend-express-prisma.md) («Гексагональный backend на Express 5 и Prisma поверх PostgreSQL 16», статус `accepted`), где разобраны причины, отличия от Express 4 и влияние на middleware-экосистему. *Приведено в соответствие 2026-07-26.*

> **Отклонение от формулировок задач — только в именах файлов.** Закрытый словарь role-суффиксов
> (`rules/naming-and-structure.mdc`, ESLint `bad-crm/require-role-suffix`) не допускает имён
> `server.ts`, `routes.ts`, `shutdown.ts`, `container.ts`. Суффикс `.factory.ts` добавлен в словарь
> штатным путём (правка правила + плагина), реализация лежит в
> `presentation/http/http-server.factory.ts`, `presentation/http/api.routes.ts`,
> `infrastructure/bootstrap/shutdown.factory.ts`, `infrastructure/bootstrap/container.factory.ts`.
> Composition root разделён на `main.ts` (три строки) и
> `infrastructure/bootstrap/api-process.factory.ts` — иначе порядок старта не покрывается тестами.

## Definition of Done

- [x] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [x] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y-проверка (для UI-историй) — не применимо
- [ ] i18n: строки в обоих языках, хардкода нет (для UI-историй) — не применимо

## Ссылки

- Документация: [`stack.md` → main.ts, composition root и graceful shutdown](../../../docs/architecture/stack.md), [`stack.md` → HTTP-hardening](../../../docs/architecture/stack.md), [`prd.md` → NFR-4](../../../docs/product/prd.md)
- Правила: `rules/naming-and-structure.mdc`, `rules/security.mdc`
