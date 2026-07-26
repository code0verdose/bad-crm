---
id: STORY-005-05
epic: EPIC-005
status: backlog
blocked: false
priority: must
estimate: M
---

# STORY-005-05 — Роли БД app_user / app_migrator / app_auth

**Как** администратор системы **я хочу** три отдельные роли БД с разными правами **чтобы** роль
приложения физически не могла обойти RLS, а SQL-инъекция не превращалась в чтение всей базы одной
строкой.

## Acceptance (Given/When/Then)

- **Given** bootstrap-скрипт ролей **When** он выполнен на чистой БД **Then** созданы `app_user` (без `BYPASSRLS`, ничего не владеет), `app_migrator` (владелец схемы и таблиц), `app_auth` (`BYPASSRLS`, владеет только `SECURITY DEFINER`-функциями); ни одна не является суперпользователем и не может создавать роли.
- **Given** повторный запуск bootstrap-скрипта **When** роли уже существуют **Then** скрипт завершается успешно и ничего не ломает (идемпотентность).
- **Given** `DATABASE_URL`, по ошибке указывающий на `app_migrator` **When** приложение стартует **Then** `assertRuntimeDbRole` завершает старт с сообщением «ожидалась роль app_user, получена app_migrator»; HTTP-порт не открывается.
- **Given** роль с `BYPASSRLS` в `DATABASE_URL` **When** приложение стартует **Then** старт падает с сообщением «роль имеет BYPASSRLS — политики не применяются».
- **Given** попытка `SET ROLE app_migrator` из-под `app_user` **When** она выполняется **Then** она отклоняется: членства нет, `pg_has_role` при старте это подтверждает.
- **Given** новая таблица без явного `GRANT` для `app_user` **When** приложение к ней обращается **Then** возвращается `42501 permission denied for table …` — громкий отказ вместо тихой утечки (`ALTER DEFAULT PRIVILEGES` не используется, проверяется тестом каталога).
- **Given** журнальные таблицы (`audit_logs` и аналоги) **When** `app_user` пытается выполнить `UPDATE`/`DELETE`/`TRUNCATE` **Then** права отозваны и операция отклоняется; `TRUNCATE` не выдан никому, кроме владельца.
- **Given** роли **When** смотрю их настройки **Then** заданы `statement_timeout`, `idle_in_transaction_session_timeout`, `lock_timeout`, `search_path` согласно `rls-design.md`.

## Задачи

- [ ] Написать тесты первыми: `test/integration/db/roles.test.ts` (атрибуты трёх ролей, отсутствие членств, лимиты), `test/unit/db/assert-db-role.test.ts` (все ветки проверки: не та роль, суперпользователь, `BYPASSRLS`, возможность `SET ROLE`), `test/integration/db/grants.test.ts` (нет default privileges; журнальные таблицы без `UPDATE`/`DELETE`).
- [ ] Реализовать `packages/server/prisma/sql/00-bootstrap-roles.sql` — создание ролей, пароли из переменных, `NOINHERIT`, лимиты; смонтировать в `/docker-entrypoint-initdb.d/`.
- [ ] Реализовать `infrastructure/persistence/prisma/assert-db-role.ts` и вызвать её в `main.ts` до `listen` и до старта воркеров.
- [ ] Настроить `schema.prisma`: `url = env("DATABASE_URL")`, `directUrl = env("DATABASE_MIGRATION_URL")`; расширить env-схему переменными `DATABASE_AUTH_URL` и `DATABASE_MIGRATION_URL` (последняя опциональна в рантайме).
- [ ] Реализовать отдельный тонкий клиент для `app_auth` с малым пулом (используется путём логина в [EPIC-006](../../epic-006-auth-core/epic.md)).
- [ ] Обновить `.env.example` и `docker-compose.yml` тремя строками подключения и раздельными паролями.
- [ ] Добавить в `docs/runbooks/` процедуру ротации паролей ролей БД и проверку, что `DATABASE_MIGRATION_URL` не остаётся в окружении контейнера приложения.
- [ ] Добавить в чек-лист `db-reviewer` пункт про `GRANT` в каждой миграции с новой таблицей.

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, **db-reviewer обязателен**, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y-проверка (для UI-историй) — не применимо
- [ ] i18n: строки в обоих языках, хардкода нет (для UI-историй) — не применимо

## Ссылки

- Документация: [`rls-design.md` → Роли и права БД, Почему приложение не ходит под владельцем](../../../docs/security/rls-design.md), [`overview.md` → Развёртывание](../../../docs/architecture/overview.md)
- Правила: `rules/tenancy-rls.mdc`, `rules/security.mdc`
