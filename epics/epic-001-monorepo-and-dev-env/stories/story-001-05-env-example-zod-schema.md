---
id: STORY-001-05
epic: EPIC-001
status: review
blocked: false
priority: must
estimate: S
---

# STORY-001-05 — .env.example и Zod-схема окружения

**Как** владелец инсталляции **я хочу** один файл со всеми переменными и жёсткую проверку при
старте **чтобы** неверная конфигурация приводила к падению с понятным сообщением сразу, а не к
загадочной 500-й ошибке через час работы.

## Acceptance (Given/When/Then)

- [ ] **Given** отсутствующая переменная `JWT_SECRET` **When** запускаю сервер **Then** процесс завершается с кодом ≠ 0 и сообщением, называющим конкретную переменную и требование (`JWT_SECRET: String must contain at least 32 character(s)`); HTTP-порт не открывается. — **частично:** схема и текст сообщения готовы и покрыты `packages/server/test/unit/env.test.ts`, но `main.ts` пока не вызывает `loadEnv()` и HTTP-порта не существует. Поведение процесса закрывается в [STORY-003-01](../../epic-003-server-skeleton-and-api-contract/stories/story-003-01-express-app-composition-root.md) (composition root: `loadEnv()` → логгер → … → `listen`). На сегодня тот же отказ демонстрирует preflight `pnpm dev`.
- [ ] **Given** `APP_ENCRYPTION_KEY`, не являющийся 32 байтами в base64 **When** запускаю сервер **Then** старт падает с сообщением `APP_ENCRYPTION_KEY must be 32 bytes, base64-encoded`. — **частично, по той же причине.** Проверено вживую 2026-07-27 на свежескопированном `.env.example`: `pnpm dev` останавливается с этой самой строкой ещё до запуска turbo.
- [x] **Given** `MEILI_HOST` задан, а `MEILI_MASTER_KEY` — нет **When** загружается схема **Then** срабатывает cross-field `.refine` и старт падает с путём ошибки `MEILI_MASTER_KEY`. *Реализовано через `superRefine`; у него есть известное ограничение — см. технический долг в [STORY-003-01](../../epic-003-server-skeleton-and-api-contract/stories/story-003-01-express-app-composition-root.md).*
- [x] **Given** полностью валидный `.env` **When** приложение стартует **Then** `loadEnv()` вызывается ровно один раз в composition root; тест проверяет, что `process.env` не читается напрямую нигде в `src/**` вне `infrastructure/bootstrap/env.ts`. *Запрет на чтение `process.env` вне bootstrap работает и покрыт фикстурой в `test/lint/architecture-rules.test.ts`. Вызов из composition root появится вместе с самим composition root ([STORY-003-01](../../epic-003-server-skeleton-and-api-contract/stories/story-003-01-express-app-composition-root.md)).*
- [ ] **Given** отсутствующие опциональные `SMTP_URL`, `MEILI_HOST`, `OTEL_EXPORTER_OTLP_ENDPOINT` **When** приложение стартует **Then** оно поднимается успешно и сообщает в лог, какие функции деградированы. — **не выполнено:** `describeDegradations()` написана и покрыта тестами, но её никто не вызывает — логгера и старта приложения ещё нет. Перенесено в [STORY-003-01](../../epic-003-server-skeleton-and-api-contract/stories/story-003-01-express-app-composition-root.md) (порядок старта) и [STORY-003-03](../../epic-003-server-skeleton-and-api-contract/stories/story-003-03-logging-request-context-app-error.md) (pino).
- [x] **Given** `.env.example` **When** запускаю тест синхронизации **Then** множество ключей в `.env.example` совпадает с множеством ключей Zod-схемы; лишний или недостающий ключ валит тест. *`test/env/env-example-sync.test.ts`; сверяются обе схемы (сервер и клиент) и `${VAR}` из compose. Сверка **значений** — открытый долг, заведён в [STORY-002-01](../../epic-002-ci-and-commit-gate/stories/story-002-01-ci-pipeline-turbo-checks.md).*
- [x] **Given** `.env.example` **When** grep по нему **Then** реальных секретов нет: чувствительные значения — плейсхолдеры вида `CHANGE_ME_...`, а `.env` присутствует в `.gitignore`.

## Задачи

- [x] Написать тесты `packages/server/test/unit/env.test.ts`: валидный набор → `parse` успешен; отсутствие каждой обязательной переменной → ошибка с ожидаемым путём; `MEILI_HOST` без ключа → ошибка `.refine`; невалидный base64 в `APP_ENCRYPTION_KEY` → ошибка.
- [x] Написать тест `test/env/env-example-sync.test.ts`: сравнивает ключи `.env.example` с `envSchema.shape`. *Схема после `superRefine` перестаёт быть `ZodObject` и `.shape` не имеет, поэтому сверка идёт против экспортированного `SERVER_ENV_KEYS`.*
- [x] Написать lint-тест: `process.env` вне `packages/server/src/infrastructure/bootstrap/env.ts` и `packages/client` (`import.meta.env`) — нарушение.
- [x] Реализовать `packages/server/src/infrastructure/bootstrap/env.ts` со схемой из [`stack.md`](../../../docs/architecture/stack.md): `NODE_ENV`, `PORT`, `APP_URL`, `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `APP_ENCRYPTION_KEY`, `S3_*`, `SMTP_URL?`, `MEILI_*?`, `AI_ENABLED`, `LOG_LEVEL`, `OTEL_*?`, `RUN_WORKERS_IN_PROCESS`, `ARGON2_*`. *Разложено на три файла по одной ответственности (`env.schema.ts`, `load-env.util.ts`, `env.errors.ts`) плюс `env-features.util.ts`; добавлены `CORS_EXTRA_ORIGINS` и `DATABASE_MIGRATION_URL`.*
- [x] Экспортировать `export type Env = z.infer<typeof envSchema>` и `loadEnv()` с `parse` (не `safeParse` — падаем громко). *Отклонение: внутри `safeParse`, но результат превращается в `EnvValidationError` и бросается — «падаем громко» сохранено, при этом в сообщение попадают **все** невалидные переменные, а не только первая. Голый `parse` печатает ZodError со **значениями** полей, то есть с секретами.*
- [x] Создать `.env.example` в корне: все переменные с комментариями, дефолты, согласованные с `docker-compose.yml`, плейсхолдеры для секретов, генератор секретов в комментарии (`openssl rand -base64 32`).
- [x] Добавить `.env`, `.env.local` в `.gitignore`; проверить сканером секретов, что в репозитории нет реальных значений.
- [ ] Вывести при старте сводку деградаций (`search: postgres-fts`, `mail: log`, `ai: disabled`) в лог уровня `info`. — **не выполнено:** `describeDegradations()` и `insecureDefaultWarnings()` реализованы и покрыты тестами, но вызывать их неоткуда — ни старта приложения, ни логгера пока нет. Перенесено в [STORY-003-01](../../epic-003-server-skeleton-and-api-contract/stories/story-003-01-express-app-composition-root.md) и [STORY-003-03](../../epic-003-server-skeleton-and-api-contract/stories/story-003-03-logging-request-context-app-error.md).

## Definition of Done

- [x] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [x] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [x] Документация обновлена (docs/ + запись в `docs/brain/`)
- [x] a11y-проверка (для UI-историй) — не применимо
- [x] i18n: строки в обоих языках, хардкода нет (для UI-историй) — не применимо

> **Статус `review`, а не `done`.** Схема, `.env.example` и их взаимная проверка готовы полностью.
> Незакрытыми остались три критерия, каждый из которых начинается словами «приложение стартует»: у
> проекта нет ни `loadEnv()` в composition root, ни логгера, ни HTTP-порта — всё это скоуп
> [EPIC-003](../../epic-003-server-skeleton-and-api-contract/epic.md). Отметить их выполненными
> значило бы утверждать, что проверено поведение процесса, которого не существует. История
> закрывается вместе со STORY-003-01 и STORY-003-03.

## Ссылки

- Документация: [`stack.md` → Конфигурация и env](../../../docs/architecture/stack.md), [`prd.md` → NFR-3, NFR-6](../../../docs/product/prd.md)
- Правила: `rules/security.mdc`, `rules/tdd-and-commit-gate.mdc`
