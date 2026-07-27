---
id: STORY-006-02
epic: EPIC-006
status: backlog
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

- [ ] Написать тесты первыми: `application/identity/use-cases/login.use-case.test.ts` (успех, неверный пароль, несуществующий пользователь, suspended), `test/integration/auth/login.test.ts` (флаги cookie, содержимое БД, неотличимость ответов), `test/unit/auth/jwt.test.ts` (claims, TTL, подпись).
- [ ] Реализовать `infrastructure/crypto/jwt-token-service.adapter.ts` под портом `AccessTokenPort` (HS256, `JWT_SECRET`, TTL из конфигурации).
- [ ] Реализовать `infrastructure/crypto/refresh-token.ts`: генерация 32 случайных байт, хеширование SHA-256 для хранения.
- [ ] Реализовать `application/identity/use-cases/login.use-case.ts` с портами `UserReaderPort`, `PasswordHasherPort`, `SessionRepositoryPort`, `ClockPort`, `AuditLoggerPort`.
- [ ] Реализовать резолв пользователя до определения организации через `app_auth` и `SECURITY DEFINER`-функцию по [`rls-design.md`](../../../docs/security/rls-design.md).
- [ ] **Права на `SECURITY DEFINER`-функции не переживают восстановление из бэкапа — и ломаются в небезопасную сторону.** Процедура из [`backup-restore.md`](../../../docs/runbooks/backup-restore.md) выполняет `pg_dump`/`pg_restore` с `--no-privileges` на обеих сторонах. Для таблиц это fail-closed: грантов нет, приложение громко падает на `permission denied`, и `01-grants.sql` их возвращает. Для функций — fail-open: PostgreSQL по умолчанию выдаёт `EXECUTE` роли `PUBLIC`, поэтому после восстановления анонимно-привилегированный резолвер доступен любой роли, а его тело исполняется от владельца, которым после `pg_restore` становится `app_migrator` — владелец схемы, а не `app_auth`. `packages/server/prisma/sql/01-grants.sql` функций не касается вовсе. Эта история заводит **первую** такую функцию, поэтому дефект надо закрыть здесь, а не после того, как их станет пять. **Сделано, когда:** функция создаётся с `OWNER TO app_auth`, `REVOKE ALL … FROM PUBLIC` и `GRANT EXECUTE` только нужной роли; `01-grants.sql` переприменяет это по каталогу `pg_proc` так же, как делает для таблиц (иначе после восстановления состояние снова разъедется); интеграционный тест после `pg_restore` проверяет владельца, отсутствие `PUBLIC EXECUTE` и фиксированный `search_path`. *(технический долг EPIC-001, зафиксирован 2026-07-27; в шапке `01-grants.sql` стоит явная отсылка сюда)*
- [ ] Реализовать контроллер `POST /api/v1/auth/login`, описать операцию в `openapi.yaml`, настроить установку cookie.
- [ ] Реализовать middleware аутентификации: разбор Bearer-токена, наполнение контекста `userId`/`organizationId`, сверка `pv` (`permissionsVersion`).
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
