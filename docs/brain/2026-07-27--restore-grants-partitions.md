---
date: 2026-07-27
project: bad-crm
tags: [PostgreSQL, pg_dump, pg_restore, RLS, Prisma, Docker Compose, backup]
---

# Восстановление из бэкапа: комментарии расширений, гранты и партиции

## Простым языком

1. **Восстановление из бэкапа обрывалось на первой же строке.** В дампе, кроме самих таблиц, лежат
   описания пяти расширений PostgreSQL. Поставить такое описание может только владелец расширения —
   суперпользователь, а восстанавливаем мы под обычной ролью. Восстановление падало, не создав ни
   одной таблицы. Теперь перед восстановлением из оглавления дампа вычёркиваются ровно эти пять
   записей — и терять нечего, потому что описания расширений и так создаются шагом раньше.
2. **После восстановления база оказывалась без прав доступа.** Дамп снимается и восстанавливается
   без прав (иначе он тянет за собой чужие роли), поэтому после него ни приложение не видит таблиц,
   ни следующий бэкап не может их прочитать. Раньше в раннбуке предлагалось «прогнать миграции» —
   это не работает: миграции все уже помечены выполненными, команда честно ничего не делает.
   Сделал отдельный файл, который раздаёт права сам, по списку таблиц из самой базы, и запускается
   и после миграций, и после восстановления.
3. **Журнал аудита не попадал в бэкап.** Он разбит на помесячные куски, и права на «общую» таблицу
   на куски не распространяются — бэкап падал именно на них. Теперь кускам выдаётся одно право:
   читать их может только роль бэкапа. Приложению они по-прежнему недоступны.
4. **Нашёл то, чего не было ни в одном документе:** ровно та же беда с последовательностями
   (счётчиками автонумерации) — бэкап читает и их, и без права падает.
5. **Смена пароля роли не доезжала до сервера.** Команда обновления ролей выполнялась внутри уже
   запущенного контейнера, а он помнит те значения, с которыми был создан, — то есть переприменяла
   старый пароль и рапортовала об успехе. Теперь она запускается в новом одноразовом контейнере.
6. **Порядок шагов восстановления был неверным:** база создавалась раньше, чем её будущий владелец.
   На новом сервере это падало. Теперь первым идёт скрипт ролей — он же и создаёт базу.

## Технически

1. `docs/runbooks/backup-restore.md:340` — `pg_restore -l db.dump | grep -v 'COMMENT - EXTENSION' >
   db.toc` + `pg_restore -L db.toc`. Воспроизведено до правки: `ERROR: must be owner of extension
   btree_gist`, exit 1, ноль таблиц. `--no-comments` отвергнут письменно — он уносит `COMMENT ON
   TABLE`/`COMMENT ON COLUMN`, которых нет нигде, кроме дампа. `pg_restore -l /dev/stdin` не
   работает (`did not find magic string in file header`), поэтому в процедуре `docker compose cp`.
2. `packages/server/prisma/sql/01-grants.sql` — новый файл. Одна транзакция, `DO`-блок, обход
   `pg_class`/`pg_attribute`, выполняется под `app_migrator` (GRANT требует владения, не
   суперпользователя). Правила: `GRANT SELECT … TO backup_role` каждой таблице **и каждому листу
   партиции**; `GRANT SELECT, INSERT, UPDATE, DELETE` + `REVOKE TRUNCATE` для tenant-таблиц
   (`organization_id` в `pg_attribute`); `GRANT SELECT, INSERT` для append-only журналов (список
   синхронен чеку 4d в `docs/security/rls-design.md`); `REVOKE ALL … FROM app_user` на листах;
   `GRANT SELECT ON SEQUENCE … TO backup_role` и `GRANT USAGE, SELECT … TO app_user`.
3. `package.json:27` — `db:grants`; `package.json:26` — `db:bootstrap` переведён с
   `docker compose exec` на `docker compose run --rm --no-deps -e PGHOST=postgres`.
   Доказательство необходимости: с `.env`, где `APP_USER_PASSWORD=rotated_from_dotenv`, `run`
   видит новое значение, `exec` — старое.
4. `packages/server/prisma/sql/initdb/00-bootstrap-roles.sh` — подключение к `MAINTENANCE_DB`
   (по умолчанию `postgres`) вместо `POSTGRES_DB`, плюс ветка `PGHOST`/`PGPASSWORD` для запуска в
   одноразовом контейнере (внутри него нет unix-сокета сервера).
5. `docs/security/rls-design.md` — правило по партициям переформулировано; чек 4g разделён на
   4g (родители) / 4g-2 (листы) / 4g-3 (последовательности) / 4h (роль вообще существует); все
   `has_table_privilege` завёрнуты в `EXISTS (SELECT 1 FROM pg_roles …)` — без гарда
   `ERROR: role "backup_role" does not exist` роняет весь чек; CI-грепп на `set_config(…, false)`
   сужен с `--exclude=00-bootstrap-roles.sql` до `grep -vF` по одной строке плюс позитивная
   проверка «вхождение ровно одно».
6. `.env.example`, `docs/architecture/stack.md`, `CHANGELOG.md` — `DATABASE_MIGRATION_URL` больше не
   описывается как необязательная «для одноконтейнерной установки»: у `app_user` нет `CREATE` на
   схеме `public` (проверено: `ERROR: permission denied for schema public`), поэтому
   `prisma migrate deploy` через `DATABASE_URL` падает на создании `_prisma_migrations`. Там же —
   preflight: он включается на всём, что **не** `development`, включая `test`, и `NODE_ENV` вынесен
   из таблицы «не ломает старт».
7. Тесты: `test/repo/runbook-restore.test.ts` (11), `test/infra/grants-sql.test.ts` (8), плюс два в
   `test/infra/compose.test.ts`. Написаны до правок, 12 из 13 были красными. Мутационная проверка
   6/6: снятие `-L`, `db:grants`→`db:migrate`, удаление сбора статистики, снятие гранта на
   sequence, отключение `REVOKE` на партициях, перестановка bootstrap после `CREATE DATABASE`.
8. Найдено прогоном, а не чтением: `DROP DATABASE` без `-d postgres` падает с `cannot drop the
   currently open database` (psql идёт в базу, одноимённую пользователю, а в dev-образе
   `POSTGRES_USER = POSTGRES_DB`); голый `ANALYZE;` под `app_migrator` печатает по
   `WARNING: permission denied to analyze` на каждый общий каталог — заменён на
   `vacuumdb --analyze-only --schema=public`.

## Применённые технологии

- [[PostgreSQL]] — `pg_dump`/`pg_restore` custom-формат, TOC и `-L`, `pg_class`/`pg_attribute`,
  партиционирование, `has_table_privilege`, `vacuumdb --analyze-only`.
- [[Docker Compose]] — разница между `exec` (окружение зафиксировано при создании контейнера) и
  `run` (окружение строится из текущей конфигурации).
- [[Prisma]] — `migrate deploy` применяет только pending-миграции, поэтому непригоден как способ
  переприменить гранты после восстановления.
- [[Vitest]] — контрактные тесты на текст раннбука и SQL, с языко-зависимым отбрасыванием
  комментариев, чтобы объяснение отвергнутой альтернативы не читалось как её использование.

## Связи

- Проект: [[Projects/bad-crm]]
- Норматив: `docs/security/rls-design.md`, `docs/runbooks/backup-restore.md`
- Related: [[2026-07-27--gate-blockers-cache-lint-coverage]]
