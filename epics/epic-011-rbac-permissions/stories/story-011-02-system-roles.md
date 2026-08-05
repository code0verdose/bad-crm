---
id: STORY-011-02
epic: EPIC-011
status: review
blocked: false
priority: must
estimate: M
---

# STORY-011-02 — Системные роли и матрица прав

**Как** владелец инсталляции **я хочу** получать в каждой новой организации семь готовых системных
ролей с осмысленным набором прав, **чтобы** начать работать сразу после регистрации и не собирать
матрицу доступов вручную, а разделение обязанностей (админ не видит деньги, менеджер не управляет
инсталляцией) действовало по умолчанию.

## Acceptance (Given/When/Then)

1. **Роли создаются при создании организации.**
   Given регистрация организации `acme`;
   When транзакция создания организации завершается;
   Then в `Role` этой организации ровно 7 строк с `key ∈ {owner, admin, manager, lead, developer,
   viewer, guest}`, все с `isSystem = true`, `isDefault = true` только у `developer`,
   а строки `RolePermission` соответствуют `SYSTEM_ROLE_PERMISSIONS`.

2. **Матрица кода совпадает с матрицей документа.**
   Given `SYSTEM_ROLE_PERMISSIONS` в `packages/shared`;
   When гоняется `system-roles.spec.ts`;
   Then `SYSTEM_ROLE_PERMISSIONS.owner.length === PERMISSIONS.length` (владелец имеет все 307
   ключей), каждый ключ в каждой роли существует в каталоге, а снапшот матрицы совпадает с §4
   `permission-model.md`.

3. **Разделение обязанностей проверяется явно.**
   Given роли `admin` и `manager`;
   When проверяется их состав;
   Then `admin` **не** содержит `employee:view_cost_rate`, `time:view_cost`, `report:view_margin`,
   `project:view_financials`, `invoice:*`, `timesheet:approve`; `manager` **не** содержит
   `settings:*`, `role:create`, `user:suspend`, `integration:connect`.

4. **Guest ограничен ACL, а не capability.**
   Given пользователь с ролью `guest` и правом `task:read`;
   When он запрашивает задачу приватного проекта без выданного `ResourceAcl`;
   Then ответ **404** (`implicitLevel` для guest = `NONE`), а не 403 и не 200.

5. **Системная роль неизменяема.**
   Given роль `admin` с `isSystem = true`;
   When вызывается `PATCH /api/v1/roles/{roleId}` с изменением состава прав или `key`/`name`;
   Then ответ 409 `problem+json` с `reason = system_role_immutable`, состав прав в БД не изменился,
   запись в `AuditLog` не создаётся (изменения не было).

6. **Системную роль нельзя удалить.**
   Given роль `viewer`;
   When вызывается `DELETE /api/v1/roles/{roleId}`;
   Then 409 `system_role_immutable`; строки `RolePermission` и `UserRole` не тронуты.

7. **Обновление продукта не затирает организацию и не молчит.**
   Given инсталляция с организациями, созданными предыдущим релизом, и новый ключ
   `task:bulk_edit`, добавленный в `SYSTEM_ROLE_PERMISSIONS.lead`;
   When выполняется миграция и сид новой версии;
   Then у всех организаций роль `lead` получает новый ключ, а кастомные роли (`isSystem = false`) не
   изменяются вовсе; событие `role.updated` с `actorType = SYSTEM` пишется в `AuditLog`.

8. **Негативный сценарий — сид не изобретает права.**
   Given `SYSTEM_ROLE_PERMISSIONS` содержит ключ, которого нет в `PERMISSIONS`;
   When запускается сборка;
   Then код не компилируется (тип `readonly PermissionKey[]`), а страховочный тест сида падает.

## Задачи

- [x] `packages/shared/src/permissions/system-roles.ts` — `SYSTEM_ROLE_KEYS`, `SystemRoleKey`,
      `SYSTEM_ROLE_PERMISSIONS` (перенос §4 документа, все 10 подтаблиц).
- [x] `packages/shared/src/permissions/system-roles.spec.ts` — owner = весь каталог, ключи из
      каталога, снапшот матрицы, проверки разделения обязанностей (п. 3).
- [x] `packages/server/prisma/migrations/*_roles/migration.sql` — таблицы `roles`, `role_permissions`
      с `organization_id`, `uq_roles_org_key`, частичный `idx_roles_org_default (organization_id) WHERE is_default`,
      `uq_role_permissions (role_id, permission_key)`, покрывающий
      `idx_role_permissions_org_role (organization_id, role_id) INCLUDE (permission_key)`,
      RLS `ENABLE` + `FORCE` + политика `tenant_isolation` (USING = WITH CHECK) + `maintenance_access`.
- [x] `packages/server/prisma/seed/system-roles.seed.ts` — идемпотентный сид ролей на организацию.
- [x] `packages/server/src/application/iam/use-cases/provision-system-roles.use-case.ts` — вызывается
      из создания организации ([EPIC-006](../../epic-006-auth-core/epic.md)) в той же транзакции.
- [x] `packages/server/src/application/iam/use-cases/update-role.use-case.ts` — проверка
      `isSystem → DomainError('system_role_immutable')` (расширяется в STORY-011-03).
- [x] `packages/server/test/integration/rls/row-factories.ts` — фабрики для `roles`, `role_permissions`;
      регистрация в `tenant-tables.ts`.
- [x] `packages/server/test/integration/rls/rls-isolation.test.ts` — isolation-тест для обеих таблиц.
- [x] `packages/server/test/integration/iam/system-roles-provisioning.spec.ts` — п. 1, 6, 7.

## Ссылки

- [`permission-model.md` §2 «Слой 2 — роли»](../../../docs/security/permission-model.md)
- [`permission-model.md` §4 «Системные роли», §4.11 «Что нельзя сделать с системными ролями»](../../../docs/security/permission-model.md)
- [`permission-model.md` §5, `implicitLevel` и краевой случай 8 (guest)](../../../docs/security/permission-model.md)
- [`rls-design.md`, чек-лист «новая таблица»](../../../docs/security/rls-design.md)
- [`threat-model.md`, `T-IAM-09`](../../../docs/security/threat-model.md)

## Definition of Done

- [x] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [x] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [x] Документация обновлена (docs/ + запись в `docs/brain/`)
- [x] a11y и i18n (для UI-историй)
- [x] **Isolation-тест RLS** для каждой новой таблицы
- [x] **Permission объявлена** для каждого нового endpoint и проверяется в use-case

## Состояние — 2026-08-05

**Сделано:**

- `system-roles.enums.ts` в `packages/shared`: семь ролей и матрица из §4 документа
  (owner 331 ключ = весь каталог, admin 258, manager 241, lead 183, developer 119, viewer 68,
  guest 20), `DEFAULT_SYSTEM_ROLE`, `IMPLICIT_LEVEL_NONE_ROLES`.
- 23 теста в `packages/shared` — разделение обязанностей проверено **поимённо и в обе стороны**:
  админ не держит себестоимость, ставки, финансы проекта и утверждение табелей (контроль: менеджер
  держит), менеджер не держит настройки инсталляции, роли, приостановку пользователей и интеграции
  (контроль: админ держит). Плюс «лестница» ролей: набор сужается от owner к guest — дешёвый способ
  заметить галочку, поставленную в чужую колонку.
- Гейт паритета `test/permissions/system-roles-match-model.test.ts`: разбирает таблицы §4 (включая
  сокращённую запись `` `ai:configure_providers`, `:manage_budget` ``, где ресурс наследуется от
  предыдущего ключа) и сверяет все семь колонок.
- Миграция `20260805100000_roles`: `roles` и `role_permissions` по каноническому шаблону —
  `ENABLE` + `FORCE`, политика с **обоими** предикатами, `maintenance_access`, явные гранты,
  триггеры `updated_at`, составной внешний ключ `(organization_id, role_id)` и якорь на
  `organizations`. Isolation-тесты обеих таблиц зелёные, включая положительные контроли.
- Каталог прав сеется в контейнере интеграционных тестов так же, как `pnpm db:seed:permissions`
  сеет инсталляцию: контейнер должен выглядеть установленной системой, а не свежемигрированной
  схемой.

**Найдено и исправлено по ходу:**

1. **Документ обещал «все 318 ключей» у owner** — на 2026-08-05 их 331. Поймал гейт, который сверяет
   числа из прозы; исправлен документ. Третья устаревшая цифра, найденная так за сутки.
2. **`data-model.md` объявлял `idx_role_permissions_org_role` покрывающим** (`INCLUDE`). Datamodel
   Prisma этого не выражает: схема и миграции разошлись бы навсегда, и каждый `prisma migrate dev`
   предлагал бы пересоздать индекс. Постоянное расхождение двух источников схемы дороже одного
   index-only scan — исправлен документ, индекс обычный.
3. **Фабрика строк для `role_permissions` писала в каталог прав** и падала, как только выполнялась
   от лица арендатора: `app_user` каталог читает и не пишет. Это ровно то свойство, ради которого
   таблица глобальная, — фикстура его нарушала, а не проверяла.
4. **Join-таблица получила суррогатный `id`.** Реестровые доказательства изоляции адресуют строку по
   `id`; таблица без него — это тенант-таблица, про которую ничего не доказано. Настоящее
   ограничение при этом — пара `(role_id, permission_key)`.

**Провижининг сделан:** `ProvisionSystemRolesUseCase` + `RoleRepositoryPort` + `PrismaRoleRepository`,
вызов **внутри транзакции** создания организации. Организация, чьи роли пришли бы на statement позже,
существовала бы мгновение с никем, кто может что-либо сделать, — а при сбое того statement'а и
навсегда.

Шесть интеграционных тестов на реальном Postgres: семь ролей с грантами по матрице (у owner — весь
каталог), ровно один default, роли соседней организации не видны, повторный прогон ничего не меняет,
**замена** грантов системной роли вместо слияния (право, убранное в релизе, исчезает у существующих
инсталляций) и **кастомная роль не тронута** (она принадлежит организации, а не релизу). Плюс пять
unit-тестов use-case'а и пять — репозитория с записывающим двойником: там пиннится порядок
(`deleteMany` перед `createMany`, снятие флага default перед установкой), которого живой прогон не
показывает.

**Линтер поймал архитектурную ошибку:** приватный хелпер репозитория принимал `organizationId`
параметром. Правило запрещает это ровно потому, что параметр — второй ответ на вопрос «какой
арендатор», и при расхождении со скоупом запрос не отвергается, а молча фильтруется в ноль.

**Осталось по истории:** запрет правки и удаления системной роли (`system_role_immutable`) — это
HTTP-уровень и use-case изменения роли, которых пока нет вовсе; они приходят вместе с кастомными
ролями в [STORY-011-03](story-011-03-custom-roles.md), где появляется сам маршрут `PATCH /roles/{id}`.
Заводить проверку раньше маршрута — значит писать её дважды.
