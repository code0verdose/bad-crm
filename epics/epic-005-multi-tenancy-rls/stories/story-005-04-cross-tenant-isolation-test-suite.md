---
id: STORY-005-04
epic: EPIC-005
status: review
blocked: false
priority: must
estimate: L
---

# STORY-005-04 — Набор тестов изоляции с положительным контролем

**Как** владелец инсталляции **я хочу** автоматический тест изоляции на каждую мультиарендную
таблицу **чтобы** отсутствие утечки было доказано машиной на каждом коммите, а не заявлено в
документации.

## Acceptance (Given/When/Then)

- [x] **Given** список мультиарендных таблиц, выведенный **из схемы Prisma автоматически** **When** добавляется новая таблица с `organizationId` **Then** она сразу попадает в набор тестов без правки списка руками. — сделано в [STORY-003-06](../../epic-003-server-skeleton-and-api-contract/stories/story-003-06-prisma-init-and-testcontainers-harness.md). *Реализация обратная по знаку и, на мой взгляд, сильнее: список написан руками (`TENANT_TABLES`), а из DMMF выводится **сверка** (`tenantTablesFromSchema()`), причём в обе стороны. Причина в комментарии к реестру: выведенный список не имеет литерального типа, поэтому `ROW_FACTORIES` нельзя объявить исчерпывающей картой — и новая таблица просто оказалась бы непокрытой. Написанный руками — это ошибка компиляции плюс падающий `tenant-tables.test.ts`.*
- [x] **Given** строка организации B **When** в контексте организации A выполняется `SELECT` по её `id` **Then** результат пуст. — сделано в [STORY-003-06](../../epic-003-server-skeleton-and-api-contract/stories/story-003-06-prisma-init-and-testcontainers-harness.md).
- [x] **Given** строка организации B **When** в контексте A выполняются `UPDATE`, `DELETE` по её `id` **Then** затронуто 0 строк; данные организации B не изменились. — сделано в [STORY-003-06](../../epic-003-server-skeleton-and-api-contract/stories/story-003-06-prisma-init-and-testcontainers-harness.md).
- [x] **Given** строки обеих организаций **When** в контексте A выполняются `SELECT *` (список) и `COUNT(*)` **Then** в выборку и в счётчик попадают только строки организации A. *`COUNT` был; **списка не было** — добавлен здесь (`LIST: an unfiltered select returns no row of the other tenant`). Разница не косметическая: счётчик и строки — разные наблюдения, и проверка «visible < total» прошла бы на политике, фильтрующей агрегат и отдающей чужие строки в список. Утверждение проверено мутацией: с тем же запросом от имени владельца в maintenance-режиме тест падает — `expected [ …(2) ] to deeply equal [ Array(1) ]`.*
- [x] **Given** контекст организации A **When** выполняется `INSERT` со значением `organization_id` организации B **Then** запрос отклоняется политикой. — сделано в [STORY-003-06](../../epic-003-server-skeleton-and-api-contract/stories/story-003-06-prisma-init-and-testcontainers-harness.md).
- [x] **Given** контекст организации A и **своя** строка **When** выполняются чтение, обновление, удаление, список и счётчик **Then** все операции успешны — **положительный контроль**. *Было три контроля из пяти (чтение, обновление, «владелец видит обе строки»). Добавлены недостающие: `CONTROL: an unfiltered list returns the tenant’s own row` и `CONTROL: the tenant may delete its own row`. Счётчик контролируется утверждением `visible > 0` внутри COUNT-теста.*
- [ ] **Given** таблица, у которой `organization_id` доступен только через родителя **When** для неё генерируется тест **Then** используется соответствующий шаблон из `rls-design.md`. — **перенесено**: таких таблиц в схеме пока нет (обе существующие несут тенант физически — `organizations` в `id`, `teams` в `organization_id`). Шаблон в [`rls-design.md`](../../../docs/security/rls-design.md) описан и ждёт первую такую таблицу; составной уникальный индекс `uq_teams_org_id`, на который будет ссылаться её FK, уже создан.
- [x] **Given** прогон набора в CI **When** он завершается **Then** отчёт перечисляет проверенные таблицы, а таблица без сгенерированного теста считается провалом. *Перечисление даёт `describe.each` (`RLS · organizations`, `RLS · teams`). «Без теста = провал» обеспечивается на компиляции (`ROW_FACTORIES` как `satisfies Record<TenantTableName, RowFactory>`) и утверждением `tenant-tables.test.ts` о равенстве реестра и схемы — отдельного отчёта нет и не нужно.*

## Задачи

- [x] Написать генератор набора первым: `test/integration/rls/tenant-scoped-tables.ts` — читает Prisma DMMF, отбирает модели с полем `organizationId`. — сделано в [STORY-003-06](../../epic-003-server-skeleton-and-api-contract/stories/story-003-06-prisma-init-and-testcontainers-harness.md): `src/infrastructure/persistence/prisma/tenant-tables.constant.ts` (`tenantTablesFromSchema()`); живёт в `src`, а не в `test`, потому что его читает и рантайм-код.
- [x] Реализовать обвязку `test/integration/rls/harness.ts`: две организации и по пользователю в каждой, `seedRowFor(org, table)`, очистка между тестами. — сделано в [STORY-003-06](../../epic-003-server-skeleton-and-api-contract/stories/story-003-06-prisma-init-and-testcontainers-harness.md): `test/integration/db/db-harness.util.ts` + `row-factories.util.ts`. *Пользователей нет — таблицы `users` не существует до [EPIC-006](../../epic-006-auth-core/epic.md); для RLS они и не нужны, политика сравнивает `app.organization_id`.*
- [x] Реализовать параметризованный набор `rls-isolation.test.ts` с `describe.each` и шестью группами проверок: read, update, delete, list, count, insert-with-foreign-org. — пять групп сделаны в [STORY-003-06](../../epic-003-server-skeleton-and-api-contract/stories/story-003-06-prisma-init-and-testcontainers-harness.md), **list добавлен здесь**. Сверх плана в наборе есть ещё две: `JOIN` (чужая строка не втягивается через связь) и «без контекста запрос падает, а не отдаёт всё».
- [x] Добавить в тот же набор блок **положительного контроля** — «своя строка видна и изменяема». *Дополнен до полного набора операций, см. критерий выше.*
- [x] Реализовать проверку «для каждой таблицы из списка существует тест», чтобы пропуск через `skip` не проходил незамеченным. *Обеспечена типами и `tenant-tables.test.ts`. Оставшиеся `it.runIf` — не пропуски, а ветвление по возможностям таблицы (`organizations` не имеет `DELETE` и не имеет колонки `organization_id`), и для каждой ветки есть парная проверка противоположного случая.*
- [ ] Добавить отдельный тест для таблиц с наследуемым `organization_id` (через родителя). — **перенесено** вместе с критерием выше: таких таблиц нет.
- [x] Подключить набор к CI-джобе интеграционных тестов; падение любой проверки — блокирующее. — сделано в [EPIC-002](../../epic-002-ci-and-commit-gate/epic.md) (job `integration` в `.github/workflows/ci.yml`).
- [x] Зафиксировать в `docs/security/rls-design.md` состав набора и порядок добавления новой таблицы. *Чек-лист «новая таблица», пункт 10, дополнен перечнем операций положительного контроля.*

## Definition of Done

- [x] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [x] Commit-гейт зелёный (test-coverage, security-auditor, **db-reviewer обязателен**, production-readiness, commit-hygiene)
- [x] Документация обновлена (docs/ + запись в `docs/brain/`)
- [x] a11y-проверка (для UI-историй) — не применимо
- [x] i18n: строки в обоих языках, хардкода нет (для UI-историй) — не применимо

## Ссылки

- Документация: [`rls-design.md` → Обязательные тесты изоляции, Параметризованный шаблон](../../../docs/security/rls-design.md), [`stack.md` → Обязательные isolation-тесты RLS](../../../docs/architecture/stack.md), [`prd.md` → NFR-1, риск R-01](../../../docs/product/prd.md)
- Правила: `rules/tenancy-rls.mdc`, `rules/testing.mdc`
