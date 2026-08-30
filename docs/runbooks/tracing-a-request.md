# Runbook: найти всё по `requestId`

Пользователь прислал скриншот с ошибкой. В теле ответа есть `requestId` — по нему восстанавливается
весь путь запроса. Ничего, кроме `docker compose logs`, для этого не нужно.

## Откуда берётся идентификатор

- Клиент присылает `x-request-id` — используется он (его ставит reverse-proxy, значение проходит
  сквозь всю цепочку). Иначе сервер генерирует ULID.
- Значение возвращается в заголовке `x-request-id` **любого** ответа и лежит в поле `requestId`
  каждого `application/problem+json`.
- Оно же попадает в каждую строку лога этого запроса — логгер подмешивает его из
  `AsyncLocalStorage`, поэтому передавать его в коде никуда не нужно.

Формат: 26 символов Crockford base32 (`01J8Z2F5Q3K9V6N0R4T7YB3XQD`). ULID сортируется по времени —
по идентификатору сразу видно, когда это было.

## Рецепт

> **`api` ниже — имя сервиса приложения в вашем compose-файле, а не в этом репозитории.**
> `docker-compose.yml` в корне поднимает только backing-сервисы (`postgres`, `redis`, `minio`,
> `minio-setup`, `meilisearch`, `mailpit`), а приложение в разработке бежит на хосте через
> `pnpm dev` — там логи идут в терминал, и `grep` применяется прямо к нему. Сервисы `api` и
> `worker` приезжают с дистрибутивным `docker-compose.prod.yml` (EPIC-017). Проверено 2026-08-30;
> имена сервисов печатает `docker compose config --services` (`grep` по отступу вернул бы ещё и
> имена томов — они объявлены на том же уровне).

```bash
# 1. Всё, что относится к запросу (логи в JSON, одна строка = одно событие)
docker compose logs --no-color --since 24h api | grep '01J8Z2F5Q3K9V6N0R4T7YB3XQD'

# 2. То же читаемо, если установлен jq: только уровень, маршрут, статус и сообщение
docker compose logs --no-color --since 24h api \
  | grep '01J8Z2F5Q3K9V6N0R4T7YB3XQD' \
  | jq -r '[.time, .level, .route // "-", .statusCode // "-", .msg] | @tsv'

# 3. Итоговая строка запроса: сколько заняло и чем закончилось
docker compose logs --no-color --since 24h api \
  | grep '01J8Z2F5Q3K9V6N0R4T7YB3XQD' \
  | jq -r 'select(.msg == "request completed" or .msg == "request failed")
           | {route, statusCode, durationMs, organizationId, userId}'
```

Поля, которые есть в итоговой строке всегда: `requestId`, `route` (шаблон `/api/v1/tasks/:taskId`, не
URL), `statusCode`, `durationMs`, `organizationId`, `userId`. Последние два заполняются на
аутентифицированных маршрутах (`presentation/http/middleware/authenticate.middleware.ts` вызывает
`requestContext.identify`) и остаются `null` на публичных — вход, регистрация, `/health`. Прежняя
редакция обещала `null` «до появления аутентификации, EPIC-006»; EPIC-006 отгружен (сверено
2026-08-30).

## Что делать, если строк нет

| Симптом | Причина | Что дальше |
|---|---|---|
| Ни одной строки с этим id | Запрос не дошёл до приложения | Смотреть логи вашего reverse-proxy (`docker compose logs <имя-сервиса-прокси> \| grep <id>`). Прокси в поставку не входит и в compose-файле репозитория его нет — имя сервиса ваше |
| Есть только `request completed` со статусом 4xx | Запрос отклонён на границе (валидация, права) | В строке уровня `warn` есть `code` — он же в ответе пользователю |
| Есть строка уровня `error` с `err.stack` | Непредвиденное исключение | Стек полный, в ответе пользователю его нет и не должно быть |
| `route` = `unmatched` | Маршрут не найден (`route_not_found`) | Проверить путь: URL в лог не пишется намеренно |

## Чего в логах нет — и не будет

Пароли, токены, cookie, `Authorization`, ключи интеграций, содержимое vault, тела запросов и URL
запросов. Первое — потому что `redact` заменяет их на `[Redacted]`, второе — потому что тела и URL не
логируются вовсе (URL защищённой ссылки сам по себе является секретом). Если нужного контекста не
хватает, добавляются **идентификаторы и размеры**, а не полезная нагрузка — см.
[`rules/observability.mdc`](../../rules/observability.mdc).

## Дальше

`traceId` в каждой строке **уже есть**: логгер подмешивает идентификатор активного спана
(`infrastructure/logging/pino-logger.adapter.ts`), а SDK стартует, когда задан
`OTEL_EXPORTER_OTLP_ENDPOINT` (`infrastructure/tracing/tracing.factory.ts`) — EPIC-009 отгружен,
сверено 2026-08-30. Чего ещё нет: наследования `requestId` job'ами очереди, потому что очередей нет
(`grep -n bullmq packages/server/package.json` — пусто). Цепочка «HTTP-запрос → outbox-событие →
письмо» станет прослеживаемой тем же grep, когда появится outbox.
