---
id: STORY-014-02
epic: EPIC-014
status: backlog
blocked: false
priority: must
estimate: M
---

# STORY-014-02 — Участники проекта и их роли

**Как** руководитель проекта (P2) **я хочу** управлять составом команды проекта и указывать роль
каждого вместе с долей загрузки, **чтобы** доступ к проекту следовал за участием, а не выдавался
отдельными записями ACL на каждого человека.

## Acceptance (Given/When/Then)

1. **Добавление участника.**
   Given руководитель с `project:manage_members` и уровнем `MANAGER` на проекте;
   When `POST /api/v1/projects/{projectId}/members` с
   `{ userId, projectRole: 'MEMBER', allocationPct: 50 }`;
   Then создаётся `ProjectMember(joinedAt = now, leftAt = null)`, инкрементится
   `permissions_version` добавленного пользователя **в той же транзакции**; в `AuditLog` —
   `project.member_added` с before/after.

2. **`projectRole` — источник `implicitLevel`.**
   Given участник без единой записи `ResourceAcl`;
   When резолвится его уровень на проекте;
   Then `LEAD → MANAGER`, `MEMBER → EDITOR`, `REVIEWER → COMMENTER`, `OBSERVER → VIEWER` —
   ровно по таблице §5 `permission-model.md` (табличный тест на все четыре значения).

3. **Не участник публичного и приватного проекта.**
   Given пользователь, не состоящий в проекте;
   When проект `PUBLIC_ORG` → уровень `VIEWER`; when проект `PRIVATE` → уровень `NONE`;
   Then во втором случае любой запрос к проекту и его дочерним ресурсам даёт **404**.

4. **Изменение роли участника.**
   Given `MEMBER` повышается до `LEAD`;
   When `PATCH /api/v1/projects/{projectId}/members/{userId}`;
   Then роль меняется, версия инкрементится, новый уровень действует со следующего запроса без
   перелогина; событие в `AuditLog`.

5. **Удаление участника.**
   Given участник выходит из проекта;
   When `DELETE /api/v1/projects/{projectId}/members/{userId}`;
   Then проставляется `leftAt = now` (строка сохраняется ради истории и ссылок), версия
   инкрементится, доступ пропадает немедленно; `uq_project_members (project_id, user_id) WHERE
   left_at IS NULL` позволяет позже вернуть человека в проект новой строкой.

6. **Негативный сценарий — самоприсоединение.**
   Given пользователь с `project:read`, но без `project:manage_members`;
   When он вызывает `POST /projects/{id}/members` со своим `userId`;
   Then 403 `permission_not_granted`; добавление самого себя запрещено отдельной проверкой даже при
   наличии права (митигация `T-PROJ-02`, тест `no-self-join-project`).

7. **Негативный сценарий — последний лид.**
   Given в проекте ровно один `LEAD`;
   When его удаляют или понижают;
   Then 409 `last_project_lead_required`; UI предлагает сначала назначить нового лида.

8. **Негативный сценарий — деактивированный или чужой пользователь.**
   Given `userId` деактивирован или принадлежит организации B;
   When он добавляется в проект;
   Then 422 `invalid_member` для деактивированного и **404** для чужого — существование чужой
   учётки не подтверждается.

9. **`allocationPct` валидируется.**
   Given `allocationPct = 150` или отрицательное;
   When приходит запрос;
   Then 422; диапазон 0…100 задан Zod и продублирован `CHECK` в БД. Суммарная загрузка сотрудника
   по проектам **не ограничивается** в M2 (это задел под планирование ёмкости в M6), но показывается
   в UI как подсказка.

10. **Список участников.**
    Given экран `/projects/$projectId/members`;
    When он открыт;
    Then фильтры `q`, `role[]` живут в URL; список строится одним запросом без N+1; вышедшие
    участники (`leftAt IS NOT NULL`) показываются только по явному фильтру.

11. **Аудит состава.**
    Given любое изменение состава;
    When оно выполнено;
    Then в `AuditLog` есть запись с актором и before/after — «добавил себя и удалил обратно после
    чтения данных» становится видимым (митигация `T-PROJ-04`).

## Задачи

- [ ] `packages/server/prisma/migrations/*_project_members/migration.sql` — `project_members`
      (`project_role`, `allocation_pct` + CHECK 0…100, `joined_at`, `left_at`), составной FK
      `(organization_id, project_id)`, `uq_project_members (project_id, user_id) WHERE left_at IS NULL`,
      `idx_project_members_org_user`, RLS `ENABLE` + `FORCE` + политики.
- [ ] `packages/server/src/application/project/use-cases/add-project-member.use-case.ts`,
      `update-project-member.use-case.ts`, `remove-project-member.use-case.ts`.
- [ ] `packages/server/src/domain/project/access/project-membership.policy.ts` —
      `canManageMembers`, `assertNotSelfJoin`, `assertLastLeadKept`.
- [ ] `packages/server/src/domain/access/implicit-level.ts` — ветка `PROJECT` (совместно с
      [STORY-011-06](../../epic-011-rbac-permissions/stories/story-011-06-resource-acl.md)).
- [ ] `packages/server/src/application/project/queries/list-project-members.query.ts`.
- [ ] Инкремент `permissionsVersion` при любом изменении членства — в той же транзакции.
- [ ] `packages/server/src/presentation/http/routes/registry.ts` — `project:manage_members`,
      `project:read` c `aclCheckedIn`.
- [ ] `packages/client/src/units/project/service/{queries,mutations,hooks}` —
      `project-members.query.ts`, `add-project-member.mutation.ts` (оптимистичный патч + rollback),
      `use-project-members.hook.ts`; `widgets/project-members/project-members.widget.tsx` +
      `ui/member-role-select.component.tsx`, `ui/allocation-field.component.tsx`.
- [ ] Тесты: `project-membership.policy.spec.ts` (п. 6, 7), `implicit-level.spec.ts` (п. 2, 3),
      интеграционные `project-members-api.spec.ts` (п. 1, 4, 5, 8, 9),
      `membership-invalidates-permissions.spec.ts` (доступ меняется без перелогина),
      isolation-тест `project_members`.

## Ссылки

- [`permission-model.md` §5 `implicitLevel` (таблица), §8 «Что инкрементит permissionsVersion»](../../../docs/security/permission-model.md)
- [`data-model.md`, группа 3, `ProjectMember`](../../../docs/architecture/data-model.md)
- [`threat-model.md`, `T-PROJ-02`, `T-PROJ-04`](../../../docs/security/threat-model.md)
- [`ux-architecture.md`, `/projects/$projectId/members`](../../../docs/architecture/ux-architecture.md)

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
