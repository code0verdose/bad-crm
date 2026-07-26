---
id: STORY-016-01
epic: EPIC-016
status: backlog
blocked: false
priority: must
estimate: M
---

# STORY-016-01 — Append-only таблица и партиционирование

**Как** владелец инсталляции (P1) **я хочу**, чтобы журнал действий было физически невозможно
изменить или удалить из приложения, **чтобы** запись в нём была доказательством, а не мнением, —
даже если код приложения окажется скомпрометирован.

## Acceptance (Given/When/Then)

1. **Схема таблицы.**
   Given миграция `audit_logs`;
   When она применена;
   Then есть колонки `organization_id`, `actor_id?`, `actor_type USER|SYSTEM|API_KEY|INTEGRATION`,
   `action`, `resource_type`, `resource_id?`, `before jsonb?`, `after jsonb?`, `ip_hash`,
   `user_agent`, `request_id`, `severity`, `occurred_at`; первичный ключ включает `occurred_at`
   (требование партиционирования).

2. **Партиционирование по месяцам.**
   Given `PARTITION BY RANGE (occurred_at)`;
   When выполняется запрос за период;
   Then план показывает pruning (читаются только нужные партиции); партиции создаются
   заблаговременно джобом `ensure-audit-partitions.job.ts` (текущий + следующие 2 месяца), и
   отсутствие партиции не приводит к ошибке вставки.

3. **Приложение не может изменить запись.**
   Given роль `app_user`;
   When выполняется `UPDATE audit_logs SET action = 'x'` или `DELETE FROM audit_logs`;
   Then ошибка прав доступа: на таблице и на **каждой партиции** выполнен
   `REVOKE UPDATE, DELETE, TRUNCATE ON ... FROM app_user`; `INSERT` и `SELECT` сохранены.

4. **Структурная проверка в CI.**
   Given `information_schema.role_table_grants`;
   When гоняется `audit-log-grants.spec.ts`;
   Then у `app_user` нет `UPDATE`/`DELETE`/`TRUNCATE` ни на родительской таблице, ни на любой
   партиции; появление такого гранта ломает сборку (`T-PLAT-05`).

5. **Новая партиция наследует ограничения.**
   Given джоб создал партицию за следующий месяц;
   When проверяются права и политики;
   Then на ней автоматически включены RLS (`ENABLE` + `FORCE`), политика `tenant_isolation`
   (USING = WITH CHECK) и те же `REVOKE`; проверяется тестом на свежесозданной партиции.

6. **Негативный сценарий — кросс-тенантное чтение.**
   Given записи организаций A и B;
   When актор организации A читает журнал;
   Then видит только свои записи; попытка вставить строку с чужим `organization_id` отклоняется
   `WITH CHECK` (isolation-тест по шаблону `rls-design.md`, включая партиционированный случай).

7. **Индексы под реальные запросы.**
   Given три типовых сценария (лента за период, история объекта, действия сотрудника);
   When они выполняются;
   Then используются `idx_audit_logs_org_occurred (organization_id, occurred_at DESC)`,
   `idx_audit_logs_resource (organization_id, resource_type, resource_id, occurred_at DESC)`,
   `idx_audit_logs_actor (organization_id, actor_id, occurred_at DESC)` — на каждой партиции.

8. **Негативный сценарий — удаление партиции из приложения.**
   Given роль `app_user`;
   When она пытается выполнить `DETACH`/`DROP PARTITION`;
   Then отказ: операции доступны только `app_migrator` (стыковка со
   [STORY-016-05](story-016-05-retention.md)).

9. **Производительность вставки.**
   Given нагрузка 200 событий/с;
   When они пишутся;
   Then вставка не становится узким местом транзакций: одна строка, без триггеров и без вычислений
   внутри транзакции; замер зафиксирован в нагрузочном сценарии.

10. **Объём и рост.**
    Given годовой объём организации на 50 человек;
    When считается размер;
    Then оценка задокументирована в runbook, а метрика `audit_log_partition_bytes` экспортируется
    для алерта.

## Задачи

- [ ] `packages/server/prisma/migrations/*_audit_logs/migration.sql` — создание партиционированной
      таблицы, дефолтная партиция-страховка, индексы, RLS `ENABLE` + `FORCE` + политики
      `tenant_isolation` и `maintenance_access`, явные `GRANT INSERT, SELECT` и
      `REVOKE UPDATE, DELETE, TRUNCATE` для `app_user`.
- [ ] `packages/server/prisma/sql/create-audit-partition.sql` — функция создания партиции с
      применением политик и грантов.
- [ ] `packages/server/src/application/platform/jobs/ensure-audit-partitions.job.ts`.
- [ ] `packages/server/src/infrastructure/persistence/prisma/tenant-tables.ts` — регистрация
      `audit_logs` (+ `ROW_FACTORIES` для isolation-теста).
- [ ] `packages/server/test/integration/rls/rls-isolation.test.ts` — партиционированный случай.
- [ ] `packages/server/test/structure/audit-log-grants.spec.ts` (п. 3, 4, 5, 8).
- [ ] `packages/server/test/integration/audit/audit-partition-pruning.spec.ts` (п. 2, 7 — через
      `EXPLAIN`).
- [ ] `docs/runbooks/audit-log.md` — оценка объёма, создание партиций, права ролей.

## Ссылки

- [`data-model.md`, группа 14 («Про `AuditLog` как append-only», партиционирование, индексы)](../../../docs/architecture/data-model.md)
- [`rls-design.md`, «Особый случай: append-только журналы», «Партиционированные таблицы (`audit_logs`)»,
  чек-лист «новая таблица»](../../../docs/security/rls-design.md)
- [`threat-model.md`, `T-PLAT-05` (топ-15, №14)](../../../docs/security/threat-model.md)
- [`permission-model.md` §10 («Изменять `AuditLog` не может никто»)](../../../docs/security/permission-model.md)
- PRD: NFR-6

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
