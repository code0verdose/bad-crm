---
id: STORY-009-01
epic: EPIC-009
status: review
blocked: false
priority: must
estimate: M
---

**Сверка с кодом 2026-08-04, до реализации.** Большая часть истории уже сделана попутно в EPIC-003 —
установлено чтением кода, а не борда:

- сквозной контекст `requestId`/`organizationId`/`userId` через `AsyncLocalStorage` и `mixin`
  логгера — есть (`pino-logger.adapter.ts:57`);
- итоговая строка с `route`, `statusCode`, `durationMs` — есть (`http-logger.middleware.ts`);
- список `redact`-путей по CLAUDE.md, включая `accessToken`/`refreshTokenHash`/`passwordHash`, и
  тест-канарейка, проверяющая **байты** вывода — есть (`test/unit/logging/redaction.test.ts`);
- вырезание `config.headers` из ошибок HTTP-клиента — есть (`log-error.serializer.ts`);
- `LoggerPort` в `application` вместо прямого pino — есть;
- JSON в stdout одной строкой, без файловых транспортов — есть и зафиксировано правилом.

**Чего не хватало и сделано сейчас:** теста на то, что тело запроса и URL не попадают в лог **ни на
каком уровне**. Сериализаторы это делали, но ничего не доказывало, что они такими останутся, — а
именно это самый вероятный «безобидный» патч при отладке. `test/unit/logging/http-log-line.test.ts`
прогоняет реальный запрос через middleware на уровне `debug` и проверяет отсутствие пароля из тела и
токена из пути, плюс что в строке лежит **шаблон** маршрута (`/s/:token`), а не сам путь.
Положительный контроль обязателен: утверждение «строки нет» удовлетворяется и пустым логом.

Человекочитаемый вывод в dev — **конвейером** (`tsx watch src/main.ts | pino-pretty`), а не
транспортом внутри процесса: правило 1 `rules/observability.mdc` запрещает второй транспорт, и
конвейер его не заводит — `pino-pretty` остаётся `devDependency` и в `pnpm install --prod` не
попадает. Проверено на конвейере, а не предположено: JSON рендерится читаемо, а не-JSON строки
(сообщения `tsx watch` о перезапуске) проходят как есть.

**Отложено с причиной: `causationId` и обёртка `runJob`.** Фоновых задач в проекте ещё нет — BullMQ
приходит с эпиком outbox, — и обёртка без единого вызывающего была бы заготовкой, которую правило
чистоты коммита не пропускает. Форма обёртки уже описана правилом 3 `rules/observability.mdc`, так
что спецификация для того эпика существует; поле `causationId` заводится вместе с первым событием,
которому есть что наследовать.

**Не проверено сквозным запуском** (на момент закрытия): `pnpm dev` целиком не поднимался — для него
нужны Postgres, Redis, MinIO и Meilisearch. Проверен сам конвейер и то, что скрипт разбирается.
*Снято 2026-08-30:* стек с тех пор поднимался целиком — под e2e (EPIC-010) и в джобе `end-to-end`,
где сервер запускается тем же способом и пишет свои строки в `packages/e2e/test-results/server.log`.


# STORY-009-01 — Логи со сквозным контекстом и редактированием секретов

**Как** администратор системы **я хочу** структурные логи, где по одному идентификатору собирается
весь путь запроса, и где заведомо нет секретов **чтобы** разбирать инциденты по данным и не бояться
передать логи наружу при обращении в поддержку.

## Acceptance (Given/When/Then)

- **Given** аутентифицированный запрос **When** он обрабатывается **Then** каждая строка лога содержит `requestId`, `organizationId`, `userId`, `route`, а итоговая — ещё `statusCode` и `durationMs`.
- **Given** цепочка «HTTP-запрос → фоновая задача» **When** задача выполняется **Then** она наследует `requestId` и `causationId` исходного запроса, и по ним восстанавливается весь путь.
- **Given** запрос с заголовками `Authorization` и `Cookie`, телом с `password` и объектом с `apiKeyEnc` **When** всё это попадает в лог **Then** значения заменены на `[Redacted]`; поиск исходных значений по логу ничего не находит.
- **Given** ошибка HTTP-клиента интеграции **When** она сериализуется **Then** `config.headers` вырезаны — токен интеграции не уезжает в лог вместе со стектрейсом.
- **Given** `LOG_LEVEL=debug` **When** обрабатывается запрос к `/api/v1/auth/*` **Then** тело всё равно не логируется.
- **Given** содержимое сообщений чата, AI-промпты и тела vault-элементов **When** соответствующие сценарии выполняются **Then** в логи попадают только идентификаторы и размеры, но не полезная нагрузка (правило зафиксировано и покрыто тестом на существующих сценариях).
- **Given** формат вывода **When** приложение работает в контейнере **Then** логи идут в stdout в JSON одной строкой на запись, без файловых транспортов.
- **Given** запуск в dev **When** разработчик читает логи **Then** доступен человекочитаемый вывод (`pino-pretty`) только в dev, а в production — строгий JSON.

## Задачи

*Отметки расставлены по коду 2026-08-30: до этого весь список стоял пустым при закрытой истории.*

- [x] Написать тесты первыми: `test/unit/logging/redaction.test.ts` (полный набор чувствительных путей + вложенные объекты), `test/unit/logging/context-propagation.test.ts` (HTTP → job, наследование `requestId`/`causationId`), `test/integration/logging/auth-body.test.ts` (тело auth-запросов не логируется ни на одном уровне).
      *Два из трёх; имена другие.* Есть `packages/server/test/unit/logging/redaction.test.ts` и
      `.../http-log-line.test.ts` (тело и URL не попадают в лог **ни на каком уровне**, с шаблоном
      маршрута и положительным контролем) — второй закрывает то, что задача просила от
      `auth-body.test.ts`. `context-propagation.test.ts` нет: цепочки «HTTP → job» не существует,
      см. `runJob` ниже.
- [x] Расширить `infrastructure/logging/pino.adapter.ts` полным списком `redact`-путей и сериализаторами ошибок и запросов.
      *Файлы — `infrastructure/logging/pino-logger.adapter.ts`, список путей вынесен в
      `log-redaction.constant.ts`, сериализатор ошибки — `log-error.serializer.ts`.*
- [x] Дополнить `RequestContext` полями `organizationId`, `userId`, `causationId` и наполнять их в auth- и tenant-middleware.
      *`organizationId`/`userId` — да: `RequestContextPort.identify` вызывается из
      `presentation/http/middleware/authenticate.middleware.ts:122`. `causationId` — нет, вместе с
      `runJob` (наследовать пока нечему).*
- [ ] Реализовать обёртку `runJob`, восстанавливающую контекст из payload задачи (используется всеми фоновыми обработчиками).
      *Открыто и на 2026-08-30: BullMQ в дереве нет (`grep -n '"bullmq"' packages/server/package.json`
      пуст), обёртывать нечего. Форма описана правилом 3 `rules/observability.mdc`.*
- [x] Реализовать `LoggerPort` и его использование в `application`/`domain` вместо прямого обращения к pino.
      *`application/platform/ports/logger.port.ts`; прямого pino вне `infrastructure/logging` нет.*
- [x] Настроить `pino-pretty` только для dev; проверить, что в production-сборке он не подключается.
      *Конвейером, а не транспортом: `packages/server/package.json` → `"dev": "tsx watch … | pino-pretty"`;
      сам пакет остаётся `devDependency`.*
- [x] Добавить тест-«канарейку»: набор строк-секретов прогоняется через логгер и проверяется отсутствие в выводе.
      *`test/unit/logging/redaction.test.ts` — проверяются **байты** вывода.*
- [x] Описать в `docs/runbooks/` рецепты: «собрать всё по requestId», «найти путь от запроса до письма».
      *[`docs/runbooks/tracing-a-request.md`](../../../docs/runbooks/tracing-a-request.md) — откуда
      берётся идентификатор, три команды разбора, что делать, если строк нет, и чего в логах нет
      намеренно. Рецепт «от запроса до письма» отдельным разделом не выделен: писем в журнале нет,
      релей пишет собственную строку исхода.*

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y-проверка (для UI-историй) — не применимо
- [ ] i18n: строки в обоих языках, хардкода нет (для UI-историй) — не применимо

## Ссылки

- Документация: [`stack.md` → Логи, Редактирование секретов в логах](../../../docs/architecture/stack.md), [`overview.md` → (з) Observability](../../../docs/architecture/overview.md)
- Правила: `rules/observability.mdc`, `rules/security.mdc`
