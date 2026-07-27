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

- **Given** отсутствующая переменная `JWT_SECRET` **When** запускаю сервер **Then** процесс завершается с кодом ≠ 0 и сообщением, называющим конкретную переменную и требование (`JWT_SECRET: String must contain at least 32 character(s)`); HTTP-порт не открывается.
- **Given** `APP_ENCRYPTION_KEY`, не являющийся 32 байтами в base64 **When** запускаю сервер **Then** старт падает с сообщением `APP_ENCRYPTION_KEY must be 32 bytes, base64-encoded`.
- **Given** `MEILI_HOST` задан, а `MEILI_MASTER_KEY` — нет **When** загружается схема **Then** срабатывает cross-field `.refine` и старт падает с путём ошибки `MEILI_MASTER_KEY`.
- **Given** полностью валидный `.env` **When** приложение стартует **Then** `loadEnv()` вызывается ровно один раз в composition root; тест проверяет, что `process.env` не читается напрямую нигде в `src/**` вне `infrastructure/bootstrap/env.ts`.
- **Given** отсутствующие опциональные `SMTP_URL`, `MEILI_HOST`, `OTEL_EXPORTER_OTLP_ENDPOINT` **When** приложение стартует **Then** оно поднимается успешно и сообщает в лог, какие функции деградированы.
- **Given** `.env.example` **When** запускаю тест синхронизации **Then** множество ключей в `.env.example` совпадает с множеством ключей Zod-схемы; лишний или недостающий ключ валит тест.
- **Given** `.env.example` **When** grep по нему **Then** реальных секретов нет: чувствительные значения — плейсхолдеры вида `CHANGE_ME_...`, а `.env` присутствует в `.gitignore`.

## Задачи

- [ ] Написать тесты `packages/server/test/unit/env.test.ts`: валидный набор → `parse` успешен; отсутствие каждой обязательной переменной → ошибка с ожидаемым путём; `MEILI_HOST` без ключа → ошибка `.refine`; невалидный base64 в `APP_ENCRYPTION_KEY` → ошибка.
- [ ] Написать тест `test/env/env-example-sync.test.ts`: сравнивает ключи `.env.example` с `envSchema.shape`.
- [ ] Написать lint-тест: `process.env` вне `packages/server/src/infrastructure/bootstrap/env.ts` и `packages/client` (`import.meta.env`) — нарушение.
- [ ] Реализовать `packages/server/src/infrastructure/bootstrap/env.ts` со схемой из [`stack.md`](../../../docs/architecture/stack.md): `NODE_ENV`, `PORT`, `APP_URL`, `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `APP_ENCRYPTION_KEY`, `S3_*`, `SMTP_URL?`, `MEILI_*?`, `AI_ENABLED`, `LOG_LEVEL`, `OTEL_*?`, `RUN_WORKERS_IN_PROCESS`, `ARGON2_*`.
- [ ] Экспортировать `export type Env = z.infer<typeof envSchema>` и `loadEnv()` с `parse` (не `safeParse` — падаем громко).
- [ ] Создать `.env.example` в корне: все переменные с комментариями, дефолты, согласованные с `docker-compose.yml`, плейсхолдеры для секретов, генератор секретов в комментарии (`openssl rand -base64 32`).
- [ ] Добавить `.env`, `.env.local` в `.gitignore`; проверить сканером секретов, что в репозитории нет реальных значений.
- [ ] Вывести при старте сводку деградаций (`search: postgres-fts`, `mail: log`, `ai: disabled`) в лог уровня `info`.

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y-проверка (для UI-историй) — не применимо
- [ ] i18n: строки в обоих языках, хардкода нет (для UI-историй) — не применимо

## Ссылки

- Документация: [`stack.md` → Конфигурация и env](../../../docs/architecture/stack.md), [`prd.md` → NFR-3, NFR-6](../../../docs/product/prd.md)
- Правила: `rules/security.mdc`, `rules/tdd-and-commit-gate.mdc`
