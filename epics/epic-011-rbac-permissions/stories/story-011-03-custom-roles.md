---
id: STORY-011-03
epic: EPIC-011
status: backlog
blocked: false
priority: must
estimate: M
---

# STORY-011-03 — Кастомные роли организации

**Как** администратор системы (P5) **я хочу** собирать собственные роли из существующих прав
каталога, **чтобы** выразить структуру своей компании («технический писатель», «внешний аудитор»),
не дожидаясь релиза продукта и не выдавая людям лишние права из ближайшей системной роли.

## Acceptance (Given/When/Then)

1. **Создание роли из ключей каталога.**
   Given администратор с правом `role:create`;
   When `POST /api/v1/roles` с `{ key: "tech_writer", name: {...}, permissions: ["doc:read","doc:update","kb_note:create"] }`;
   Then создаётся `Role(isSystem = false)` и три строки `RolePermission`; ответ 201 с телом роли;
   в `AuditLog` — `role.created` с `after = { key, name, permissions[] }` и `severity = warning`.

2. **Негативный сценарий — изобрести право нельзя.**
   Given тот же администратор;
   When в `permissions` передаётся `"doc:teleport"` или deprecated-ключ `"legacy:thing"`;
   Then 422 `problem+json`, ни одна строка не создана, Zod-схема отвергает значение вне
   `PERMISSION_SET` (для deprecated — отдельная причина `permission_deprecated`).

3. **Негативный сценарий — нельзя выдать то, чего нет у себя.**
   Given администратор без права `invoice:issue`;
   When он создаёт роль, включающую `invoice:issue`;
   Then 403 с `reason = permission_not_granted` и полем `permission: "invoice:issue"`; роль не
   создана. (Митигация `T-IAM-09`: правило «нельзя выдать capability, которой нет у выдающего».)

4. **Негативный сценарий — опасные права требуют подтверждения.**
   Given роль включает ключ с `dangerous: true` (например `user:impersonate`);
   When запрос приходит без заголовка подтверждения `X-Confirm-Dangerous: 1`;
   Then 428 `problem+json` с перечнем опасных ключей; повторный запрос с подтверждением проходит и
   пишет `AuditLog` с `severity = critical`.

5. **Изменение состава прав роли.**
   Given кастомная роль с 3 правами и 12 носителями;
   When `PATCH /api/v1/roles/{roleId}` меняет состав на 5 прав;
   Then в одной транзакции: синхронизируются `RolePermission`, инкрементится `permissions_version`
   **всем 12 носителям** одним `UPDATE ... WHERE id IN (SELECT user_id FROM user_roles WHERE role_id = $1)`,
   пишется `AuditLog` с полным набором ключей до и после (не дельтой).

6. **Негативный сценарий — самоблокировка.**
   Given администратор, у которого право `role:update` приходит только из редактируемой роли;
   When он убирает `role:update` из состава этой роли;
   Then 409 с `reason = self_lockout`, изменения не применены.

7. **Удаление роли.**
   Given кастомная роль с носителями;
   When `DELETE /api/v1/roles/{roleId}`;
   Then в одной транзакции удаляются `RolePermission` и `UserRole`, инкрементится версия всем бывшим
   носителям, `ResourceAcl` с `subjectType = ROLE, subjectId = roleId` удаляются, пишется
   `role.deleted` с `before`; ответ 204. Пользователи теряют права роли на следующем же запросе.

8. **Уникальность ключа внутри организации.**
   Given роль `tech_writer` уже есть;
   When создаётся ещё одна с тем же `key`;
   Then 409 `role_key_taken` (нарушение `uq_roles_org_key`), никаких дублей.

9. **Кросс-тенантность.**
   Given `roleId` роли организации B;
   When администратор организации A вызывает `PATCH /api/v1/roles/{roleId}`;
   Then **404** (`resource_not_found`), а не 403 — существование чужой роли не подтверждается.

## Задачи

- [ ] `packages/server/src/application/iam/use-cases/create-role.use-case.ts`,
      `update-role.use-case.ts`, `delete-role.use-case.ts`.
- [ ] `packages/server/src/application/iam/queries/list-roles.query.ts`, `get-role-detail.query.ts`
      (роль + число носителей + состав прав).
- [ ] `packages/server/src/application/iam/ports/role-repository.port.ts`,
      `role-access-reader.port.ts`.
- [ ] `packages/server/src/domain/iam/access/role-access.policy.ts` — `canCreateRole`,
      `canUpdateRole`, `canGrantPermissions` (правило «не выдать больше, чем есть у себя»),
      `assertNoSelfLockout`.
- [ ] `packages/server/src/domain/iam/role.entity.ts`, `role.errors.ts`
      (`system_role_immutable`, `role_key_taken`, `self_lockout`, `permission_deprecated`).
- [ ] `packages/server/src/presentation/http/validators/role.validator.ts` — Zod-схемы с
      `.strict()`, `z.enum` по `PERMISSIONS`.
- [ ] `packages/server/src/presentation/http/routes/registry.ts` — записи `role:read`, `role:create`,
      `role:update`, `role:delete` с `aclCheckedIn`.
- [ ] `packages/server/src/infrastructure/persistence/prisma/role.repository.ts` — массовый инкремент
      `permissionsVersion` одним `UPDATE`.
- [ ] Тесты: `role-access.policy.spec.ts` (табличный), `create-role.use-case.spec.ts`,
      интеграционный `roles-api.spec.ts` (п. 3, 4, 6, 7, 9).
- [ ] OpenAPI: `docs/api/openapi.yaml` — секция `/roles`.

## Ссылки

- [`permission-model.md` §2 «Слой 2 — роли»](../../../docs/security/permission-model.md)
- [`permission-model.md` §5, краевые случаи 5 и 11 (роль удалена, self-lockout)](../../../docs/security/permission-model.md)
- [`permission-model.md` §8 «Что инкрементит permissionsVersion»](../../../docs/security/permission-model.md)
- [`permission-model.md` §10 «Аудит»](../../../docs/security/permission-model.md)
- [`threat-model.md`, `T-IAM-09`](../../../docs/security/threat-model.md)

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
