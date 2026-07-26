---
id: STORY-017-02
epic: EPIC-017
status: backlog
blocked: false
priority: must
estimate: M
---

# STORY-017-02 — Миграции при старте контейнера

**Как** владелец инсталляции (P1) **я хочу**, чтобы обновление версии применяло миграции само,
**чтобы** апгрейд был одной командой и не требовал ручных действий с базой, — но чтобы неудачная
миграция останавливала старт, а не оставляла систему «наполовину обновлённой».

## Acceptance (Given/When/Then)

1. **Миграции применяются при старте.**
   Given новая версия образа;
   When контейнер стартует;
   Then entrypoint выполняет `prisma migrate deploy` под ролью `app_migrator`, затем сид
   справочников (permissions, системные роли) в той же транзакции, и только после этого поднимает
   HTTP-сервер.

2. **Разделение ролей БД соблюдено.**
   Given три роли (`app_migrator`, `app_user`, `app_auth`);
   When приложение работает;
   Then `DATABASE_MIGRATION_URL` используется **только** entrypoint'ом и снимается из окружения
   процесса приложения сразу после миграций; рантайм ходит под `app_user` без `BYPASSRLS` и не
   являясь владельцем схемы.

3. **Защита от гонки при нескольких инстансах.**
   Given два контейнера приложения стартуют одновременно;
   When оба доходят до миграций;
   Then применяется PostgreSQL advisory-lock: один выполняет миграции, второй ждёт и продолжает;
   двойного применения не происходит (конкурентный тест).

4. **Негативный сценарий — миграция упала.**
   Given миграция завершилась ошибкой;
   When entrypoint это видит;
   Then контейнер завершается с ненулевым кодом и **внятным** сообщением (какая миграция, какая
   ошибка, что делать); HTTP-сервер не поднимается; в логе явно указано, что система осталась на
   предыдущей схеме.

5. **Идемпотентность.**
   Given миграции уже применены;
   When контейнер перезапускается;
   Then `migrate deploy` ничего не делает, сид выполняет `upsert` без дублей, старт занимает
   секунды.

6. **Только обратимые изменения.**
   Given релиз содержит миграцию с `DROP COLUMN` или `ALTER TYPE`;
   When она ревьюится агентом `db-reviewer` и тестом миграций;
   Then вердикт `FAIL`: разрушающие операции запрещены в одном релизе с добавлением; действует схема
   expand → migrate → contract (`R-10`, `T-SH-06`).

7. **Компромисс задокументирован.**
   Given решение «миграции при старте»;
   When читается `docs/runbooks/install.md` и ADR;
   Then явно записано: плюс — обновление в одну команду (это и есть обещание NFR-3); минус — при
   нескольких инстансах нужен лок, а неудачная миграция задерживает старт; альтернатива (отдельный
   job деплоя) описана и остаётся доступной через переменную `RUN_MIGRATIONS_ON_START=false`.

8. **Рекомендация бэкапа.**
   Given обновление версии;
   When entrypoint обнаруживает непримененные миграции;
   Then в лог выводится напоминание о бэкапе и о том, где взять команду восстановления; при
   `BACKUP_BEFORE_MIGRATE=true` (если сконфигурирован путь) выполняется дамп до применения
   (backup-first для self-host).

9. **Негативный сценарий — привилегированная роль.**
   Given `DATABASE_URL` указывает на владельца схемы или роль с `BYPASSRLS`;
   When приложение стартует;
   Then старт отклоняется (`refuses-to-start-as-owner`) — RLS иначе молча исчезает (`T-TENANT-04`).

10. **Наблюдаемость.**
    Given применение миграций;
    When оно завершилось;
    Then в структурный лог пишется список применённых миграций и длительность; метрика
    `migrations_applied_total` и `migration_duration_seconds` доступны для алерта.

11. **Проверка на объёме.**
    Given миграция, добавляющая индекс на большую таблицу;
    When она ревьюится;
    Then используется `CREATE INDEX CONCURRENTLY` вне транзакции (по правилам `data-model.md`), и
    миграция проверена на снапшоте прод-объёмов; блокировки ограничены `lock_timeout`.

## Задачи

- [ ] `packages/server/docker-entrypoint.sh` — advisory-lock, `prisma migrate deploy`, сид,
      снятие `DATABASE_MIGRATION_URL`, обработка кодов возврата, `RUN_MIGRATIONS_ON_START`.
- [ ] `packages/server/prisma/sql/00-bootstrap-roles.sql` — создание `app_migrator`, `app_user`,
      `app_auth` (переиспользование из [EPIC-005](../../epic-005-multi-tenancy-rls/epic.md)).
- [ ] `packages/server/src/infrastructure/persistence/db-role-guard.ts` — проверка при старте
      (`current_user`, `rolbypassrls`, владелец схемы) → отказ старта.
- [ ] `packages/server/scripts/backup-before-migrate.sh` — опциональный дамп перед миграцией.
- [ ] `docs/architecture/adr/00XX-migrations-on-container-start.md` — ADR с обоснованием
      компромисса и альтернативой.
- [ ] `docs/runbooks/install.md` и `docs/runbooks/upgrade.md` — процедура обновления и точка отката.
- [ ] Тесты: `docker-entrypoint.spec.ts` (п. 4, 5 — на контейнере), конкурентный
      `migration-advisory-lock.spec.ts` (п. 3), `refuses-to-start-as-owner.spec.ts` (п. 9),
      `no-destructive-migrations.spec.ts` (п. 6).

## Ссылки

- [`prd.md`, NFR-3 («миграции применяются автоматически при старте, обратно совместимо»), риск `R-10`](../../../docs/product/prd.md)
- [`data-model.md`, «Стратегия миграций» (expand → migrate → contract, жёсткие запреты,
  `CREATE INDEX CONCURRENTLY`, «Backup-first для self-host»)](../../../docs/architecture/data-model.md)
- [`rls-design.md`, «Роли и права БД», «`DATABASE_URL` для каждой роли», «Миграции и RLS»](../../../docs/security/rls-design.md)
- [`threat-model.md`, `T-SH-06`, `T-TENANT-04`](../../../docs/security/threat-model.md)

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
