---
date: 2026-07-29
project: bad-crm
tags: [rate-limiter-flexible, ioredis, Redis, Express, Zod, PostgreSQL, pino, Vitest, Testcontainers]
---

# EPIC-006: закрытие находок гейта безопасности

## Простым языком

1. **Подключил ограничитель частоты к маршрутам входа.** Он был написан и протестирован, но его
   никто не вызывал — то есть форма входа принимала сколько угодно попыток подряд, а публичная
   регистрация позволяла анонимно создавать организации без ограничений. Теперь бюджет попыток
   тратится **до** проверки пароля: проверка пароля стоит 19 мегабайт памяти, и ограничитель,
   вызванный после неё, защищает уже потраченный ресурс.
2. **Открыл соединение с Redis в точке сборки приложения** и закрываю его при остановке, а `/ready`
   теперь честно спрашивает Redis, жив ли он. Если Redis недоступен — вход отклоняется, а не
   пропускается: иначе «выключить Redis» стало бы самым дешёвым способом отключить защиту от
   перебора паролей.
3. **Сделал обнаружение кражи refresh-токена находимым машиной.** Раньше единственным следом была
   фраза в тексте лога; теперь у события есть отдельное поле `event`, по которому можно построить
   алерт, не завися от формулировки. Записи в журнал аудита и письма пользователю по-прежнему нет —
   не из чего: таблицы аудита не существует, а почтовый порт не собран. Это явно записано в историю,
   а не выдано за сделанное.
4. **Убрал безусловное доверие к заголовку с адресом клиента.** Приложение считало, что перед ним
   стоит прокси, а в поставке прокси нет. Значит, адрес в сессиях писал сам клиент: владелец
   аккаунта видел бы в списке сессий чужую сеть, а разбор инцидента — подделанные данные. Теперь
   число доверенных прокси задаётся переменной окружения и по умолчанию равно нулю.
5. **Четыре мелочи:** неверное утверждение в комментарии про CSRF-защиту (и объяснение, почему
   чистить cookie там было бы хуже), непоследовательная ветка выбора организации при входе,
   комментарий в миграции, описывавший отвергнутый вариант владельца функции, и три имени полей,
   которые не попадали под маску секретов в логах.

## Технически

1. `packages/server/src/application/identity/use-cases/login.use-case.ts` — добавлен
   `RateLimitPort`; `consume('auth_attempt', { ipAddress, email })` вызывается первым, до
   `candidates()`/`verifyAll()`; `allowed: false` → `RateLimitedError(retryAfterSeconds)`
   (заголовок `Retry-After` ставит `error-handler.middleware.ts`); `reset` вызывается только когда
   сессия действительно выдаётся. `ServiceUnavailableError` из адаптера не перехватывается — 503
   объявлен в спеке.
2. `register-organization.use-case.ts` — `consume('organization_registration', { ipAddress })`
   после проверки `REGISTRATION_OPEN`, но до `hasher.hash` и до транзакции bootstrap.
   `refresh-session.use-case.ts` — `consume('api_request', { userId: undefined, ipAddress })` до
   поиска токена.
3. `infrastructure/redis/redis.client.ts` (новый) — `connectRedis` с `enableOfflineQueue: false`,
   `maxRetriesPerRequest: 1`, `commandTimeout: 2000` и слушателем `error` (без него `error` без
   слушателя = `unhandledRejection`). `infrastructure/redis/redis-readiness.adapter.ts` (новый) —
   проба читает `client.status` и только потом шлёт `PING`; в `detail` кладётся статус, а не
   сообщение драйвера (оно цитирует connection string).
4. `infrastructure/rate-limit/detached-rate-limit.adapter.ts` (новый) — заглушка для контейнера без
   Redis по образцу `detached-database.adapter.ts`; `consume` **отказывает**
   (`ServiceUnavailableError`), `reset` молчит.
5. `infrastructure/bootstrap/container.factory.ts` — `ContainerInput.redis?: RedisConnection`,
   сборка `createRedisWindowLimiters(client)` + `RedisRateLimiterAdapter`, шаг `redis` в
   `shutdownSteps`, живая проба в `CheckReadinessUseCase`.
   `api-process.factory.ts` — новый шов `connectRedis`, порядок `env → logger → database → redis →
   db-role → listen`.
6. `domain/identity/security-event.constant.ts` (новый) — закрытый каталог `SECURITY_EVENTS`;
   `refresh-session.use-case.ts` пишет `{ event: SECURITY_EVENTS.refreshReuseDetected, … }`, а
   сообщение стало человеческой фразой.
7. `infrastructure/bootstrap/env.schema.ts` — `TRUSTED_PROXY_HOPS` через хелпер `hopCount`
   (сверка с `/^\d+$/`, а не `z.coerce.number()`: `Number('')` равно нулю и превратил бы
   недописанную строку в осознанный ноль). `http-server.types.ts` → `config.trustedProxyHops`;
   `http-server.factory.ts` — `app.set('trust proxy', dependencies.config.trustedProxyHops)` вместо
   литерала `1`. Плюс `.env.example`, `docs/runbooks/install.md` §3.1.
8. `presentation/http/middleware/same-origin.middleware.ts` — переписан комментарий: cookie
   намеренно **не** чистится, иначе любая страница в интернете получает рабочий logout через
   `SameSite=Lax`-форму. `route-registry.factory.ts` — `publicReason` на `register` и `login`
   приведены к факту.
9. `login.use-case.ts` — статус фильтрует кандидатов один раз
   (`usable = verified.filter(status === 'ACTIVE')`), `refuseInactive` принимает список.
10. `infrastructure/logging/log-redaction.constant.ts` — добавлены `accessToken`,
    `refreshTokenHash`, `passwordHash` в обоих написаниях (pino сопоставляет ключ целиком).
11. `prisma/migrations/20260729120000_.../migration.sql` — исправлен комментарий: владелец функций
    `app_auth_definer`, а не `app_auth`. Мутация владельца роняет весь `db`-проект на
    `ERROR: must be able to SET ROLE "app_auth"` — `app_migrator` не член `app_auth` по замыслу.

## Применённые технологии

- [[rate-limiter-flexible]] — распределённый счётчик попыток поверх Redis.
- [[ioredis]] — клиент Redis; `enableOfflineQueue: false` — то, что делает fail-closed достижимым.
- [[Express]] — `trust proxy` как конфигурация, а не константа.
- [[Zod]] — схема окружения, отказ вместо догадки на пустой строке.
- [[pino]] — `redact` по путям; сопоставление ключа целиком.
- [[Vitest]] / [[Testcontainers]] — юнит-набор и живые PostgreSQL/Redis/Mailpit.

## Связи

- Проект: [[Projects/bad-crm]]
- Истории: STORY-006-01, STORY-006-02, STORY-006-03, STORY-006-07
- Related: [[2026-07-29--auth-vertical-and-unrun-suites]]
