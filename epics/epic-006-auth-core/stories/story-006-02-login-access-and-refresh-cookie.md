---
id: STORY-006-02
epic: EPIC-006
status: review
blocked: false
priority: must
estimate: M
---

# STORY-006-02 — Логин: access-токен и refresh в httpOnly cookie

**Как** разработчик (пользователь продукта) **я хочу** входить по email и паролю и оставаться в
системе между перезагрузками вкладки **чтобы** не вводить пароль каждые пятнадцать минут и при
этом не хранить долгоживущий токен там, где его достанет XSS.

## Acceptance (Given/When/Then)

- **Given** верные email и пароль **When** отправляю `POST /api/v1/auth/login` **Then** в теле возвращается access-токен (JWT, TTL 15 минут, claims `sub`, `org`, `sid`, `role`, `pv`) и профиль пользователя; refresh приходит в `Set-Cookie` с флагами `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/api/v1/auth`.
- **Given** несуществующий email **When** отправляю логин **Then** ответ 401 с тем же кодом и тем же текстом, что и при неверном пароле; время ответа не позволяет различить случаи (проверяется тестом на постоянное время выполнения хеширования-заглушки).
- **Given** пользователь со статусом `SUSPENDED` **When** он вводит верный пароль **Then** вход отклоняется отдельным кодом `account_suspended`, сессия не создаётся.
- **Given** успешный вход **When** смотрю таблицу `sessions` **Then** сохранён SHA-256 хеш refresh-токена, `family_id`, `user_agent`, `ip_hash`, `expires_at` (30 дней); сам токен в БД не хранится.
- **Given** организация ещё неизвестна на момент проверки email **When** выполняется резолв пользователя **Then** используется путь `app_auth` через `SECURITY DEFINER`-функцию с фиксированной сигнатурой, а не обход RLS из основного пула.
- **Given** пользователь состоит в нескольких организациях **When** он входит **Then** он выбирает организацию явно (или входит в единственную), и `org` в токене соответствует выбору; подмена `org` в запросе не влияет на контекст.
- **Given** access-токен **When** смотрю клиент **Then** он хранится только в памяти вкладки; в `localStorage`/`sessionStorage` его нет (проверяется тестом).
- **Given** запрос к защищённому endpoint'у с просроченным access-токеном **When** он приходит **Then** ответ 401 `unauthenticated`; сам refresh при этом не расходуется.

## Задачи

- [x] Написать тесты первыми: `application/identity/use-cases/login.use-case.test.ts` (успех, неверный пароль, несуществующий пользователь, suspended), `test/integration/auth/login.test.ts` (флаги cookie, содержимое БД, неотличимость ответов), `test/unit/auth/jwt.test.ts` (claims, TTL, подпись).
      *Сделано 2026-07-29:* `test/unit/application/login.use-case.test.ts` (16 тестов, включая
      «unknown ≡ wrong» по коду, статусу и **числу вызовов verify»**),
      `test/unit/crypto/jwt-access-token.test.ts` (claims, TTL, `alg: none`, чужая audience,
      подпись, отсутствующие claims), `test/integration/http/auth-endpoints.test.ts` (флаги cookie,
      побайтовое равенство тел 401).
- [x] Реализовать `infrastructure/crypto/jwt-token-service.adapter.ts` под портом `AccessTokenPort` (HS256, `JWT_SECRET`, TTL из конфигурации).
      *Сделано 2026-07-29:* `infrastructure/crypto/jwt-access-token.adapter.ts` на `jose` 6.2.4;
      алгоритм, issuer и audience задаёт **проверяющая** сторона, а не заголовок токена, поэтому
      `alg: none` и алгоритмическая подмена отвергаются.
- [x] Реализовать `infrastructure/crypto/refresh-token.ts`: генерация 32 случайных байт, хеширование SHA-256 для хранения.
      *Сделано 2026-07-29:* `infrastructure/crypto/refresh-token.adapter.ts` (32 байта CSPRNG,
      base64url для cookie, SHA-256 в БД). Рядом — `address-hasher.adapter.ts`: `ip_hash` считается
      **HMAC**-SHA256 под `APP_ENCRYPTION_KEY`, потому что голый SHA-256 от IPv4 обратим перебором
      2³² и колонка была бы адресом с лишним шагом.
- [x] Реализовать `application/identity/use-cases/login.use-case.ts` с портами `UserReaderPort`, `PasswordHasherPort`, `SessionRepositoryPort`, `ClockPort`, `AuditLoggerPort`.
      *Сделано 2026-07-29:* порты — `AuthLookupPort`, `PasswordHasherPort`, `UserRepositoryPort`,
      `UnitOfWorkPort`, `IssueSessionUseCase`. `AuditLoggerPort` не заводился: журнала аудита ещё
      нет (EPIC-009/EPIC-016), а пустой порт — это порт без потребителя. Прозрачный перехеш при
      поднятых параметрах выполняется в той же транзакции, что и создание сессии.
      *Уточнено 2026-07-29 (гейт безопасности), две правки:*
      (1) добавлен `RateLimitPort`: `consume('auth_attempt', {ip, email})` вызывается **первым**, до
      резолва и до любой проверки пароля, `reset` — после того, как сессия действительно выдаётся
      (STORY-006-07);
      (2) ветка «нужно выбрать организацию» возвращала список **до** проверки `status`, хотя ниже
      одиночный приостановленный аккаунт отвергался. Один и тот же аккаунт вёл себя по-разному в
      зависимости от того, сколько строк вернул резолвер, и в списке выбора могла оказаться
      организация, войти в которую нельзя. Теперь статус фильтрует кандидатов один раз
      (`usable = verified.filter(status === 'ACTIVE')`), а `account_suspended` отдаётся, когда
      **ни один** из проверенных кандидатов не активен и хотя бы один приостановлен. Свойство «код
      отказа не зависит от числа аккаунтов» покрыто тремя тестами в
      `test/unit/application/login.use-case.test.ts` → «a suspended account among several».
- [x] Реализовать резолв пользователя до определения организации через `app_auth` и `SECURITY DEFINER`-функцию по [`rls-design.md`](../../../docs/security/rls-design.md).
      *Сделано 2026-07-29:* три функции в миграции
      `20260729120000_auth_owner_and_lookup_functions` — `auth_lookup_user(citext, text)`,
      `auth_lookup_users_by_email(citext)`, `auth_lookup_session(bytea)`; адаптер
      `infrastructure/persistence/prisma/auth-lookup.adapter.ts` на отдельном пуле
      (`DATABASE_AUTH_URL`), и это **единственный** модуль, который его видит.
      **Два отступления от текста `rls-design.md`, оба осознанные и оба нужно подтвердить:**
      1. **Ролей две, а не одна.** `SECURITY DEFINER` исполняется с правами *владельца*, а
         `BYPASSRLS` снимает политики, но не привилегии — владелец без `SELECT` получает
         `permission denied for table users` изнутри функции (проверено на PostgreSQL 16.14).
         Выдать этот `SELECT` роли, которой подключается приложение, значит сделать
         `DATABASE_AUTH_URL` кредом, дампящим все учётки всех организаций. Поэтому: `app_auth`
         (LOGIN, нулевые табличные привилегии, только `EXECUTE`) и `app_auth_definer` (NOLOGIN,
         `BYPASSRLS`, `SELECT` ровно на три таблицы) — владелец функций.
      2. **`auth_lookup_users_by_email` возвращает все совпадения (LIMIT 8), а не «ничего при
         n<>1».** Договор (`OrganizationSelectionRequired`) требует показывать список организаций
         **только после** успешной проверки пароля, что без хешей невозможно. Наружу множественность
         не выходит: use-case проверяет каждого кандидата и описывает только совпавших.
      Узость пути доказана `test/integration/db/auth-lookup-path.test.ts` (26 тестов): `app_auth` не
      читает ни одной таблицы напрямую, `app_user` не может вызвать ни одну из функций, у каждой
      закреплён `search_path`, `PUBLIC` не имеет `EXECUTE`, других `SECURITY DEFINER`-функций в
      схеме нет.
- [x] **Права на `SECURITY DEFINER`-функции не переживают восстановление из бэкапа — и ломаются в небезопасную сторону.** Процедура из [`backup-restore.md`](../../../docs/runbooks/backup-restore.md) выполняет `pg_dump`/`pg_restore` с `--no-privileges` на обеих сторонах. Для таблиц это fail-closed: грантов нет, приложение громко падает на `permission denied`, и `01-grants.sql` их возвращает. Для функций — fail-open: PostgreSQL по умолчанию выдаёт `EXECUTE` роли `PUBLIC`, поэтому после восстановления анонимно-привилегированный резолвер доступен любой роли, а его тело исполняется от владельца, которым после `pg_restore` становится `app_migrator` — владелец схемы, а не `app_auth`. `packages/server/prisma/sql/01-grants.sql` функций не касается вовсе. Эта история заводит **первую** такую функцию, поэтому дефект надо закрыть здесь, а не после того, как их станет пять. **Сделано, когда:** функция создаётся с `OWNER TO app_auth`, `REVOKE ALL … FROM PUBLIC` и `GRANT EXECUTE` только нужной роли; `01-grants.sql` переприменяет это по каталогу `pg_proc` так же, как делает для таблиц (иначе после восстановления состояние снова разъедется); интеграционный тест после `pg_restore` проверяет владельца, отсутствие `PUBLIC EXECUTE` и фиксированный `search_path`. *(технический долг EPIC-001, зафиксирован 2026-07-27; в шапке `01-grants.sql` стоит явная отсылка сюда)*
      *Закрыто 2026-07-29:* `01-grants.sql` обходит `pg_proc` по `prosecdef`, возвращает владельца
      `app_auth_definer`, снимает `EXECUTE` у `PUBLIC`, выдаёт его только `app_auth`, и **отказывается
      применяться**, если у `SECURITY DEFINER`-функции нет закреплённого `search_path`. Порядок
      важен и записан в файле: привилегии выдаёт текущий владелец (`SET LOCAL ROLE`), передача
      владения — последней. Тест «после `pg_restore` состояние восстановлено» —
      `test/integration/db/auth-lookup-path.test.ts` («is put back by 01-grants.sql after a restore
      has widened it»), он же ломает состояние суперюзером, потому что ни одна прикладная роль так
      не может.
- [ ] Реализовать контроллер `POST /api/v1/auth/login`, описать операцию в `openapi.yaml`, настроить установку cookie.
      *(2026-07-28: **описание в спеке сделано**, маркер `x-implemented-by: STORY-006-02`.
      Access-токен в теле, refresh только в `Set-Cookie` (`HttpOnly`, `Secure`, `SameSite=Lax`,
      `Path=/api/v1/auth`, 30 дней) — в схемах тела refresh не появляется нигде. Неверный пароль и
      несуществующий email — один ответ `401 invalid_credentials`, это записано в
      `components.responses.InvalidCredentials` как требование, а не как совпадение.
      `account_suspended` достижим только после успешной проверки пароля, иначе он сам стал бы
      оракулом. Выбор организации при нескольких членствах — 200 с
      `status: organization_selection_required` и повтор с `organizationSlug`. `Idempotency-Key`
      объявлен игнорируемым: сохранённый ответ здесь — это сохранённые учётные данные.
      Контроллер и установка cookie — за этой историей.)*
      *Дозакрыто 2026-07-29:* маркер снят, маршрут в реестре, cookie ставится
      `presentation/http/refresh-cookie.util.ts` (`HttpOnly`, `Secure`, `SameSite=Lax`,
      `Path=/api/v1/auth`, 30 дней) — и это **единственное** место, куда попадает refresh-токен:
      сериализаторы его не принимают.
- [x] Реализовать middleware аутентификации: разбор Bearer-токена, наполнение контекста `userId`/`organizationId`, сверка `pv` (`permissionsVersion`).
      *Сделано 2026-07-29:* `presentation/http/middleware/authenticate.middleware.ts` +
      `application/identity/use-cases/authenticate-session.query.ts`. Гард навешивается **обходом
      реестра** (`requiresAuthentication`), а не руками на каждом маршруте. Сверяются подпись,
      живость строки сессии, статус аккаунта и `pv`.
      *Дозакрыто 2026-07-29 (гейт продакшен-готовности), две правки:*
      (1) **«наполнение контекста» было не сделано.** Гард клал вызывающего в `res.locals` под
      символом — это отвечает на вопрос «кто это» контроллеру и никому больше, — а
      `RequestContextPort` продолжал отдавать `organizationId: null, userId: null` на **каждой**
      строке каждого аутентифицированного запроса, включая завершающую строку `pino-http`, на
      которой построены все дашборды (`rules/observability.mdc`, правило 2). Расследование «кто
      закрыл чужие сессии» сводилось к ручному сопоставлению строк по времени. Добавлен
      `RequestContextPort.identify(caller)`; `AsyncRequestContextAdapter` мутирует **store текущего
      запроса**, а не открывает вложенный `run` — вложенная область заполнила бы поля обработчику и
      оставила бы `null` в строке, которая пишется после его возврата. `requestContext` объявлен
      обязательной зависимостью гарда, поэтому гард без него не компилируется.
      (2) **`await authenticate.execute(bearer).catch(() => undefined)` глотал всё.** Отказ пула,
      таймаут и любая ошибка внутри запроса превращались в 401. По контракту клиент на 401 идёт
      обновлять токен, получает 401 и чистит сессию — то есть тридцатисекундная недоступность базы
      разлогинивала всю организацию, и ни одной строки о причине в логе не оставалось, потому что
      исключение не доходило до обработчика ошибок. Теперь глотается **только**
      `UnauthenticatedError`, остальное пробрасывается и становится 5xx.
      Покрытие: `test/unit/http/authenticate-middleware.test.ts`,
      `test/unit/logging/request-context.test.ts`, `test/integration/http/auth-endpoints.test.ts`
      («stamps the tenant and the caller on the completion line»).
- [x] **Записывать вход, отказ входа и отзыв сессий в лог** — добавлено гейтом продакшен-готовности
      2026-07-29. Во всём слое `application/identity` был ровно один вызов логгера (детект повторного
      использования refresh-токена), поэтому неудачный вход был виден только общей строкой
      `request rejected` без субъекта и без источника: «один источник, 10 000 попыток» и «10 000
      человек ошиблись паролем» давали одинаковый лог. Каталог `SECURITY_EVENTS` расширен тремя
      именами (`sign_in_failed`, `sign_in_succeeded`, `sessions_revoked`); имя события — **поле**,
      не подстрока в тексте. `LoginUseCase` пишет `warn` на каждый отказ (`outcome`:
      `invalid_credentials` / `account_suspended` / `rate_limited`) и `info` на успех; адрес —
      только маскированный (`domain/identity/mask-ip-address.util.ts`), email не пишется вовсе.
      Причина отказа существует **только в логе**: ответ по-прежнему один на все три случая.
- [ ] Реализовать клиентский экран `/login`: форма, обработка ошибок по коду, сохранение токена в памяти, публикация события `logged-in`.

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, **db-reviewer обязателен**, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y-проверка: автофокус на первом поле, сообщение об ошибке связано с формой и объявляется скринридером
- [ ] i18n: строки в обоих языках, хардкода нет

## Ссылки

- Документация: [`stack.md` → Токены и сессии](../../../docs/architecture/stack.md), [`rls-design.md` → Путь 1. Логин](../../../docs/security/rls-design.md), [`ux-architecture.md` → `/login`](../../../docs/architecture/ux-architecture.md)
- Правила: `rules/security.mdc`, `rules/api-contract.mdc`
