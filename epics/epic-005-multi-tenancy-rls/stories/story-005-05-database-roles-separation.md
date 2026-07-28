---
id: STORY-005-05
epic: EPIC-005
status: review
blocked: false
priority: must
estimate: M
---

# STORY-005-05 — Роли БД app_user / app_migrator / app_auth

**Как** администратор системы **я хочу** три отдельные роли БД с разными правами **чтобы** роль
приложения физически не могла обойти RLS, а SQL-инъекция не превращалась в чтение всей базы одной
строкой.

## Acceptance (Given/When/Then)

- [x] **Given** bootstrap-скрипт ролей **When** он выполнен на чистой БД **Then** созданы `app_user`, `app_migrator`, `app_auth`, `backup_role` с правильными атрибутами; ни одна не суперпользователь и не может создавать роли. — сделано в [STORY-001-04](../../epic-001-monorepo-and-dev-env/stories/story-001-04-docker-compose-dev-services.md) (`prisma/sql/00-bootstrap-roles.sql`), проверяется `test/integration/db/migrations.test.ts` → «database roles».
- [x] **Given** повторный запуск bootstrap-скрипта **When** роли уже существуют **Then** скрипт завершается успешно и ничего не ломает. — сделано в [STORY-001-04](../../epic-001-monorepo-and-dev-env/stories/story-001-04-docker-compose-dev-services.md). *Скрипт не просто идемпотентен: атрибуты и членства переприменяются на **каждом** запуске, поэтому роль, созданная кем-то раньше с `INHERIT` или с `BYPASSRLS`, чинится, а не пропускается молча.*
- [x] **Given** `DATABASE_URL`, по ошибке указывающий на `app_migrator` **When** приложение стартует **Then** `assertRuntimeDbRole` завершает старт с сообщением «ожидалась роль app_user, получена app_migrator»; HTTP-порт не открывается. *Реализовано здесь: `assert-db-role.util.ts` + вызов в `api-process.factory.ts` до `listen`. Порядок шагов зафиксирован тестом (`['env', 'logger', 'database', 'db-role', 'listen']`), отказ — тоже: при отказе последовательность обрывается на `db-role`, `listened` пуст, код выхода 1. Против живой БД проверены **все четыре** роли контейнера, и три из них должны получить отказ (`test/integration/db/assert-db-role.test.ts`).*
- [x] **Given** роль с `BYPASSRLS` в `DATABASE_URL` **When** приложение стартует **Then** старт падает с сообщением «роль имеет BYPASSRLS — политики не применяются». *Реализовано здесь; проверено на `backup_role` и на суперпользователе контейнера.*
- [x] **Given** попытка `SET ROLE app_migrator` из-под `app_user` **When** она выполняется **Then** она отклоняется: членства нет, `pg_has_role` при старте это подтверждает. *Членств нет с [STORY-001-04](../../epic-001-monorepo-and-dev-env/stories/story-001-04-docker-compose-dev-services.md); проверка при старте добавлена здесь. Важна деталь: `pg_has_role(…, 'MEMBER')`, а не `'USAGE'` — для `NOINHERIT`-роли `USAGE` отвечает `false` там, где `SET ROLE` всё ещё возможен, то есть проверка прошла бы мимо ровно той ошибки, ради которой написана.*
- [x] **Given** новая таблица без явного `GRANT` для `app_user` **When** приложение к ней обращается **Then** возвращается `42501 permission denied for table …`. — сделано в [STORY-001-04](../../epic-001-monorepo-and-dev-env/stories/story-001-04-docker-compose-dev-services.md): `ALTER DEFAULT PRIVILEGES` не используется, `test/integration/db/migrations.test.ts` → «leaves PUBLIC with nothing at all» и сверка привилегий с реестром.
- [ ] **Given** журнальные таблицы (`audit_logs` и аналоги) **When** `app_user` пытается выполнить `UPDATE`/`DELETE`/`TRUNCATE` **Then** права отозваны. — **перенесено в [STORY-016-01](../../epic-016-audit-log/stories/story-016-01-append-only-table.md)**: журнальных таблиц нет. Правило уже написано авансом (список `append_only` в `01-grants.sql`) и сверяется с реестром привилегий, но проверить его на живой таблице пока не на чем. `TRUNCATE` не выдан никому — это проверяется и сейчас.
- [x] **Given** роли **When** смотрю их настройки **Then** заданы `statement_timeout`, `idle_in_transaction_session_timeout`, `lock_timeout`, `search_path`. — сделано в [STORY-001-04](../../epic-001-monorepo-and-dev-env/stories/story-001-04-docker-compose-dev-services.md).

## Задачи

- [x] Написать тесты первыми: `test/integration/db/roles.test.ts`, `test/unit/db/assert-db-role.test.ts` (все ветки: не та роль, суперпользователь, `BYPASSRLS`, возможность `SET ROLE`), `test/integration/db/grants.test.ts`. *Роли и гранты покрыты в [STORY-001-04](../../epic-001-monorepo-and-dev-env/stories/story-001-04-docker-compose-dev-services.md)/[STORY-003-06](../../epic-003-server-skeleton-and-api-contract/stories/story-003-06-prisma-init-and-testcontainers-harness.md) внутри `test/integration/db/migrations.test.ts`. Здесь написаны недостающие: `test/unit/persistence/assert-db-role-util.test.ts` (пять веток решения плюс случай «каталог не вернул строку») и `test/integration/db/assert-db-role.test.ts` (четыре реальные роли, из них три — отказ).*
- [x] Реализовать `packages/server/prisma/sql/00-bootstrap-roles.sql`; смонтировать в `/docker-entrypoint-initdb.d/`. — сделано в [STORY-001-04](../../epic-001-monorepo-and-dev-env/stories/story-001-04-docker-compose-dev-services.md).
- [x] Реализовать `infrastructure/persistence/prisma/assert-db-role.ts` и вызвать её в `main.ts` до `listen` и до старта воркеров. *Файл — `assert-db-role.util.ts` (закрытый словарь суффиксов). Вызов — не в `main.ts`, а в `infrastructure/bootstrap/api-process.factory.ts`: `main.ts` в этом проекте — три строки именно потому, что код, живущий только в точке входа, недостижим для тестов, а порядок шагов старта — как раз то, что не должно регрессировать. Заодно появился `database.factory.ts` (пул + `guardedClient`) и шаг закрытия пула в graceful shutdown.*
- [x] Настроить `schema.prisma`: `url = env("DATABASE_URL")`, `directUrl = env("DATABASE_MIGRATION_URL")`. — сделано в [STORY-003-06](../../epic-003-server-skeleton-and-api-contract/stories/story-003-06-prisma-init-and-testcontainers-harness.md).
- [ ] Расширить env-схему переменной `DATABASE_AUTH_URL` и реализовать отдельный тонкий клиент для `app_auth` с малым пулом. — **перенесено в [STORY-006-02](../../epic-006-auth-core/stories/story-006-02-login-access-and-refresh-cookie.md)**: у `app_auth` единственное назначение — три `SECURITY DEFINER`-функции пути логина, которых ещё нет. Обязательная переменная окружения и пул соединений без единого потребителя — это и заготовка, которую запрещает `rules/commit-hygiene.mdc`, и лишняя `BYPASSRLS`-поверхность, открытая раньше, чем она нужна. Роль в БД при этом уже создана и уже проверяется тестами.
- [ ] Обновить `.env.example` и `docker-compose.yml` тремя строками подключения и раздельными паролями. — **частично:** две строки (`DATABASE_URL`, `DATABASE_MIGRATION_URL`) и четыре раздельных пароля есть с [STORY-001-04](../../epic-001-monorepo-and-dev-env/stories/story-001-04-docker-compose-dev-services.md)/[STORY-001-05](../../epic-001-monorepo-and-dev-env/stories/story-001-05-env-example-zod-schema.md); третья строка — вместе с `DATABASE_AUTH_URL` выше.
- [x] Добавить в `docs/runbooks/` процедуру ротации паролей ролей БД и проверку, что `DATABASE_MIGRATION_URL` не остаётся в окружении контейнера приложения. *[`install.md` §5.4](../../../docs/runbooks/install.md): пять шагов ротации (генерация → тот же bootstrap-скрипт → строки подключения → перезапуск → пробный дамп под `backup_role`), плюс пункт чек-листа с командой проверки окружения и предупреждение про `log_statement = ddl`.*
- [ ] Добавить в чек-лист `db-reviewer` пункт про `GRANT` в каждой миграции с новой таблицей. — **не сделано:** `db-reviewer` — общий агент пользователя (`~/.claude/agents/`), а не файл этого репозитория; правка чужого конфига из истории проекта — не то решение, которое стоит принимать молча. Эквивалент внутри репозитория уже есть: пункты 8 и 8a чек-листа «новая таблица» и проектный агент `tenancy-rls-auditor`.
- [x] **Гранты на последовательности выданы шире собственного правила.** *Закрыто. `01-grants.sql` теперь выдаёт `app_user` права на последовательность только если её владеющая таблица (`pg_depend` → `pg_class`) сама попала под грант, иначе `REVOKE ALL`; `backup_role` сохраняет `SELECT` на всех — этого требует `pg_dump`. Дефект воспроизведён тестом до правки: `app_user` получал `SELECT, USAGE` на последовательность `_prisma_migrations`. Проверка обеих сторон правила — `test/integration/db/sequence-grants.test.ts` (на живом каталоге, с положительным контролем) и `test/infra/grants-sql.test.ts` (на тексте файла). Формулировка задачи требовала файл `test/infra/grants-sql.test.ts` — он уже существовал и как раз закреплял старое, широкое правило; его утверждение переписано.*

## Definition of Done

- [x] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [x] Commit-гейт зелёный (test-coverage, security-auditor, **db-reviewer обязателен**, production-readiness, commit-hygiene)
- [x] Документация обновлена (docs/ + запись в `docs/brain/`)
- [x] a11y-проверка (для UI-историй) — не применимо
- [x] i18n: строки в обоих языках, хардкода нет (для UI-историй) — не применимо

## Ссылки

- Документация: [`rls-design.md` → Роли и права БД, Почему приложение не ходит под владельцем](../../../docs/security/rls-design.md), [`overview.md` → Развёртывание](../../../docs/architecture/overview.md)
- Правила: `rules/tenancy-rls.mdc`, `rules/security.mdc`
