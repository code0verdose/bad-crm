---
date: 2026-08-30
project: bad-crm
tags: [audit-log, rbac, postgresql, prisma, multi-tenancy, tdd]
---

# Пересид системных ролей теперь пишет в журнал действий

## Простым языком

1. Проверил заявку сверки: состав системной роли задан кодом, поэтому после каждого обновления
   продукта команда `pnpm db:provision-roles` раздаёт актуальный состав всем организациям
   инсталляции. Прочитал use-case и скрипт — журнала он не касался вовсе. Значит, права людей могли
   поехать в понедельник, а в журнале про это ничего. Заявка верна.
2. Сделал так, чтобы прогон оставлял след — но только там, где он что-то реально поменял. Запись
   ложится внутрь организации, чьи права сдвинулись: читатель такой записи — владелец этой
   организации, а не оператор у консоли.
3. Идемпотентный прогон, ничего не менявший, не пишет ничего. Иначе на инсталляции с сотнями
   организаций каждый релиз давал бы сотни записей «ничего не произошло», и настоящее изменение
   стало бы ненаходимым.
4. Создание новой организации тоже молчит: её семь ролей — это не «поехали права», а то, что ей
   выдали при регистрации, и про это уже есть отдельная запись.

## Технически

1. `packages/server/src/application/iam/ports/role-repository.port.ts` — `provisionSystemRoles`
   возвращает `SystemRoleProvisioning` (`roles`, `preexistingCount`, `changes`) вместо голого
   списка `RoleSummary`. `SystemRoleChange` несёт `granted`/`revoked`/размеры, а не два полных
   состава.
2. `infrastructure/persistence/prisma/role.repository.ts` — перед заменой грантов читает текущий
   состав по ключам черновиков (`storedCompositions`) и считает дельту множествами, а не сравнением
   упорядоченных списков: порядок грантов даёт планировщик, и сравнение списков объявляло бы
   изменившимися все роли на каждом прогоне.
3. `application/iam/use-cases/provision-system-roles.use-case.ts` — принимает `AuditLoggerPort`,
   `execute({ organizationId })`, пишет `role.updated` (или `role.created` для роли, добавленной
   релизом в существующую организацию) при `preexistingCount > 0`. `actor.userId` не задан — и
   `actorType = SYSTEM` выводит писатель (`audit-log.adapter.ts:111`), а не call site.
4. Транзакционность: `record` ждётся внутри `withTenant` вызывающего, то есть в той же транзакции,
   что и изменение прав; внешних вызовов в транзакции нет.
5. `scripts/provision-system-roles.ts` — собирает `PrismaAuditLogger` (`HmacAddressHasher`,
   `AsyncRequestContextAdapter`, pino как unscoped-сток) и открывает один `requestId` на весь
   прогон: колонка `request_id` объявлена `NOT NULL`, запасной вариант писателя — пустая строка, и
   записи одного обновления было бы нечем сгруппировать.
6. Каталог действий не расширялся: `role.created`/`role.updated` уже были, severity берётся из
   действия. Поправлен устаревший комментарий каталога, объявлявший их делом только кастомных ролей
   (`packages/shared/src/audit/audit-action.enums.ts`).
7. Тесты: шесть unit-случаев в `test/unit/iam/provision-system-roles.test.ts` и два интеграционных
   в `test/integration/db/system-roles-provisioning.test.ts` (строка в `audit_logs` с
   `actor_type = SYSTEM`, и контроль «повторный прогон не пишет ничего»). Сид и бутстрап в тестах
   получили **отказывающий** сток — регрессия, которая начнёт писать на регистрации, роняет тест.

## Применённые технологии

- [[PostgreSQL]] — партиционированный append-only `audit_logs`, RLS по арендатору.
- [[Prisma]] — upsert состава ролей и чтение «до» в той же транзакции.
- [[TypeScript]] — `exactOptionalPropertyTypes`: `before` добавляется спредом, а не как `undefined`.
- [[Vitest]] — TDD-цикл: четыре красных случая до реализации.

## Связи

- Проект: [[Projects/bad-crm]]
- История: `epics/epic-011-rbac-permissions/stories/story-011-02-system-roles.md`, критерий 7
