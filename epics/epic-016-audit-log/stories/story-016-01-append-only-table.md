---
id: STORY-016-01
epic: EPIC-016
status: review
blocked: false
priority: must
estimate: M
---

# STORY-016-01 — Append-only таблица и партиционирование

**Как** владелец инсталляции (P1) **я хочу**, чтобы журнал действий было физически невозможно
изменить или удалить из приложения, **чтобы** запись в нём была доказательством, а не мнением, —
даже если код приложения окажется скомпрометирован.

> **Сверено 2026-09-06, дополнено в тот же день замерами.** Открытых критериев не осталось:
> закрыты все десять. Шесть (1, 3, 4, 5, 6, 8) закрывала миграция `20260805110000_audit_logs` и
> тесты `test/integration/db/audit-log-append-only.test.ts` и `rls-isolation.test.ts`; оставшиеся
> четыре половины закрыты прогоном, а не чтением кода:
>
> - **п. 2 и п. 7 (`EXPLAIN`)** — `test/integration/db/audit-partition-pruning.test.ts`: 240 000
>   строк, шесть месяцев, две организации, параметры связанные так, как их шлёт Prisma. Лента за
>   период читает **одну** партицию против девяти без фильтра; `count(*)` за период — 728 страниц
>   против 4 368. Каждый из трёх сценариев идёт своим индексом на отсечённой партиции. Числа и как
>   их читать — `docs/runbooks/audit-log.md`, раздел «Запросы».
> - **п. 9 (стоимость вставки)** — `test/integration/db/audit-insert-cost.test.ts`, с контрольным
>   плечом: та же транзакция без строки журнала. Дельта **0.92 мс** на типовой записи и **2.01 мс**
>   на правке роли с 331 ключом — 0.6 % и 1.3 % бюджета NFR-2 в 150 мс.
> - **п. 10 (метрика)** — `audit_log_partition_bytes` экспортируется
>   (`infrastructure/metrics/prom-client.adapter.ts`), читается
>   `infrastructure/persistence/prisma/audit-log-size.adapter.ts`, объявлена в
>   `rules/observability.mdc` и стоит сигналом 15 в `docs/runbooks/hosting.md` §9.1.
>
> **Прежняя причина отсрочки была наполовину неверна, и это стоит помнить.** «На пустой таблице
> `EXPLAIN` покажет одну партицию просто потому, что данных нет» — нет: отсечение по диапазону
> ключа партиционирования происходит на этапе планирования, до чтения строк, и пустая таблица
> отсекает так же, как полная. Объём нужен был для другого — для п. 7: на партиции в несколько
> строк планировщик правильно предпочтёт последовательное чтение, и «использует индекс» без засева
> не проверяется никак. Отсрочка была верной по факту и неверной по обоснованию.
>
> `done` ждёт только commit-гейта. П. 4 закрыт тестом с другим именем —
> `test/integration/db/audit-log-append-only.test.ts`, а не `test/structure/audit-log-grants.spec.ts`.

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

Отметки проставлены 2026-09-06 по факту кода; расхождения имён с планом — в разделе «Отклонения»
ниже, он остаётся верным.

- [x] `packages/server/prisma/migrations/20260805110000_audit_logs/migration.sql` —
      партиционированная таблица, дефолтная партиция-страховка, три индекса, RLS `ENABLE` + `FORCE`,
      политики `tenant_isolation` и `maintenance_access`, `GRANT SELECT, INSERT` и
      `REVOKE UPDATE, DELETE, TRUNCATE` для `app_user`.
- [x] Функция создания партиции с политиками и грантами — `create_audit_partition(date)` в той же
      миграции, а не отдельным файлом под `prisma/sql/` (такого файла нет): одна функция на все три
      источника партиции (миграция, команда обслуживания, оператор).
- [x] Команда обслуживания вместо фоновой задачи — `packages/server/scripts/ensure-audit-partitions.ts`
      и `scripts/audit-partitions.util.ts` (обоснование — в «Отклонениях»).
- [x] Регистрация `audit_logs` в `infrastructure/persistence/prisma/tenant-tables.constant.ts:55`.
- [x] Isolation-тест партиционированного случая — `test/integration/db/rls-isolation.test.ts` плюс
      `test/integration/db/audit-log-append-only.test.ts`, который перечисляет **каждую** партицию
      через общий каталог (`PARTITION_ROW_SECURITY_SQL`), а не родителя.
- [x] Структурная проверка грантов (п. 3, 4, 5, 8) — в том же
      `test/integration/db/audit-log-append-only.test.ts`: попытки `UPDATE`/`DELETE`/`DETACH` ролью
      `app_user` и чтение `information_schema.role_table_grants` после них. Отдельного файла под
      каталога структурных тестов в дереве нет — проверка живёт там, где есть живой Postgres.
- [x] Замеры вместо рассуждений (п. 2 в части `EXPLAIN`, п. 7, п. 9) — два файла вместо одного и с
      суффиксом `.test.ts`, а не `.spec.ts` (`spec` не запускается ни одним раннером Vitest в этом
      репозитории): `test/integration/db/audit-partition-pruning.test.ts` — отсечение партиций и
      использование трёх индексов на засеянных 240 000 строках;
      `test/integration/db/audit-insert-cost.test.ts` — стоимость записи против контрольного плеча
      плюс структурная проверка «ни одного триггера на таблице и её партициях».
- [x] Метрика `audit_log_partition_bytes` (п. 10) —
      `src/infrastructure/persistence/prisma/audit-log-size.adapter.ts` (сумма
      `pg_total_relation_size` по партициям; родитель хранилища не имеет и отвечает нулём),
      `src/infrastructure/metrics/cached-reading.util.ts` (окно в минуту: `collect` идёт по графику
      того, кто скрейпит), регистрация в `prom-client.adapter.ts`, привилегии доказаны от имени
      `app_user` в `test/integration/db/audit-log-size.test.ts`.
- [x] `docs/runbooks/audit-log.md` — оценка объёма, создание партиций, права ролей, а с 2026-09-06
      разделы «Запросы» и «Стоимость записи» с числами и условиями замера. Метрика описана там же и
      сигналом 15 в `docs/runbooks/hosting.md` §9.1.

## Отклонения от плана задач (2026-08-05)

- **`ensure-audit-partitions.job.ts` — не фоновая задача, а команда обслуживания**
  (`packages/server/scripts/ensure-audit-partitions.ts`, `pnpm db:audit-partitions`). Создание
  партиции — это `CREATE TABLE`, а приложение подключается ролью `app_user`, которая ничем не владеет
  и создавать ничего не может: роль, способная создать таблицу, способна создать таблицу без
  политики. Та же граница привилегий, на которую опирается п. 8 (`DETACH` только `app_migrator`).
  Команда вызывается из процедуры обновления (шаг 7d) и из установки; запуск по расписанию придёт
  вместе с очередями EPIC-021, горизонт в два месяца — запас именно на это.
- **`audit-partition-pruning.spec.ts` (п. 2 в части `EXPLAIN`, п. 9, п. 10) не написан.**
  ~~Pruning и скорость вставки — свойства объёма: на пустой таблице `EXPLAIN` покажет одну партицию
  просто потому, что данных нет~~ — **снято 2026-09-06**, см. врезку в начале файла: отсечение
  происходит на этапе планирования и от объёма не зависит, объём нужен был индексам. Замеры
  сделаны, файлов два и оба `.test.ts`.
- **«200 событий/с» из п. 9 замерены не как поток, а как цена одной записи.** Нагрузочного
  сценария у продукта нет, и синтетический поток в 200 вставок/с мерил бы пропускную способность
  контейнера, а не то, чего требует критерий («вставка не становится узким местом транзакций»).
  Узкое место — понятие о доле, поэтому замер сделан с контрольным плечом и приведён к бюджету
  запроса: 0.6 % на типовой записи. Пропускная способность станет осмысленной величиной, когда
  появится нагрузочный сценарий целиком, а не для одной таблицы.

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
