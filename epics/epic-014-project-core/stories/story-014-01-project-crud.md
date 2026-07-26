---
id: STORY-014-01
epic: EPIC-014
status: backlog
blocked: false
priority: must
estimate: M
---

# STORY-014-01 — Создание и редактирование проекта

**Как** руководитель проекта (P2) **я хочу** завести проект с человекочитаемым ключом, статусом,
видимостью, лидом и сроками, **чтобы** появилось пространство, к которому дальше пристёгиваются
задачи, документы, файлы и часы.

## Acceptance (Given/When/Then)

1. **Создание проекта.**
   Given пользователь с правом `project:create`;
   When `POST /api/v1/projects` с `{ key: "BAD", name, description?, visibility: "PUBLIC_ORG",
   leadId, startedAt?, dueAt?, color }`;
   Then создаётся `Project(status = ACTIVE, taskCounter = 0)`; создатель и лид добавляются как
   `ProjectMember(projectRole = LEAD)`; в `AuditLog` — `project.created`.

2. **Ключ нормализуется и уникален.**
   Given `key = " bad "`;
   When приходит запрос;
   Then значение приводится к `BAD` (`trim` + upper-case через `.transform` в Zod-схеме); формат —
   `^[A-Z][A-Z0-9]{1,9}$`; повторный `BAD` внутри организации даёт 409 `project_key_taken`
   (`uq_projects_org_key ... WHERE deleted_at IS NULL`); тот же ключ в другой организации допустим.

3. **Редактирование.**
   Given участник с правом `project:update` и уровнем ≥ `EDITOR`;
   When `PATCH /api/v1/projects/{projectId}`;
   Then изменяются `name`, `description`, `leadId`, `startedAt`, `dueAt`, `color`; в `AuditLog` —
   `project.updated` с before/after.

4. **Негативный сценарий — смена ключа после создания.**
   Given у проекта есть задачи;
   When в `PATCH` передаётся `key`;
   Then 422 `project_key_immutable`: ключ входит в номера задач (`BAD-14`), его смена сломала бы
   ссылки; поле отсутствует во входной схеме редактирования.

5. **Негативный сценарий — недостаточный уровень.**
   Given участник с `projectRole = OBSERVER` (неявный уровень `VIEWER`) и capability
   `project:update`;
   When он редактирует проект;
   Then 403 `insufficient_acl_level` (`project:update` требует `EDITOR`).

6. **Негативный сценарий — нет capability.**
   Given участник с уровнем `MANAGER`, но без права `project:update`;
   When он редактирует проект;
   Then 403 `permission_not_granted` — конъюнкция capability ∧ ACL, а не дизъюнкция.

7. **Смена видимости — опасная операция.**
   Given проект `PUBLIC_ORG`;
   When он переводится в `PRIVATE` (право `project:manage_visibility`, `dangerous`, уровень
   `MANAGER`);
   Then требуется подтверждение; сводка показывает, сколько сотрудников потеряет доступ; в
   `AuditLog` — `project.visibility_changed` с повышенной `severity`; поисковые документы проекта
   ставятся на переиндексацию (задел под M4).

8. **Негативный сценарий — даты.**
   Given `dueAt < startedAt`;
   When приходит запрос;
   Then 422 с ошибкой на конкретном поле (`.superRefine` с `path: ['dueAt']`), inline в форме,
   не тост.

9. **Негативный сценарий — лид не из организации.**
   Given `leadId` пользователя организации B или деактивированного сотрудника;
   When приходит запрос;
   Then 422 `invalid_lead`; кросс-тенантный `projectId` в `PATCH` даёт **404**.

10. **Финансовые поля не отдаются.**
    Given участник без `project:view_financials` / `project:view_budget`;
    When он читает проект;
    Then ответ не содержит ключей `budget*`, `cost*`, `margin*` — фильтрация серверным
    сериализатором, а не скрытием на клиенте (`T-PROJ-05`).

11. **Мягкое удаление.**
    Given проект удалён (`project:delete`, `dangerous`, уровень `MANAGER`);
    When он запрашивается любым репозиторием;
    Then он не возвращается: фильтр `deletedAt IS NULL` навешен через Prisma-`$extends`, а не
    расставлен руками (табличный тест `soft-deleted-invisible-in-all-repositories`).

## Задачи

- [ ] `packages/server/prisma/migrations/*_projects/migration.sql` — таблица `projects`
      (`key`, `name`, `description`, `status`, `visibility`, `lead_id`, `client_id`, `started_at`,
      `due_at`, `color`, `task_counter`, `deleted_at`), `uq_projects_org_key ... WHERE deleted_at IS NULL`,
      `idx_projects_org_status ... WHERE deleted_at IS NULL`, `idx_projects_org_client`,
      RLS `ENABLE` + `FORCE` + `tenant_isolation` (USING = WITH CHECK) + `maintenance_access`.
- [ ] `packages/server/src/domain/project/project.entity.ts`, `project.errors.ts`,
      `project-key.value.ts` (нормализация и формат).
- [ ] `packages/server/src/application/project/use-cases/create-project.use-case.ts`,
      `update-project.use-case.ts`, `change-project-visibility.use-case.ts`,
      `delete-project.use-case.ts`.
- [ ] `packages/server/src/application/project/ports/project-repository.port.ts`.
- [ ] `packages/server/src/presentation/http/serializers/project.serializer.ts` — уровни
      (базовый / участник / финансовый).
- [ ] `packages/server/src/presentation/http/validators/project.validator.ts` — Zod `.strict()`,
      `.transform` для `key`, `.superRefine` для дат.
- [ ] `packages/server/src/presentation/http/routes/registry.ts` — `project:create/update/delete/
      manage_visibility` c `aclCheckedIn`.
- [ ] `packages/client/src/units/project/{model/validation,service,ui}` —
      `project.schema.ts`, `create-project.mutation.ts`, `update-project.mutation.ts`,
      `use-project-form.hook.ts`; `widgets/project-form/project-form.widget.tsx`.
- [ ] i18n: `packages/client/src/app/i18n/{en,ru}/project.json`.
- [ ] Тесты: `project-key.value.spec.ts`, `project-access.policy.spec.ts` (п. 5, 6),
      интеграционные `projects-api.spec.ts` (п. 2, 4, 7–9, 11), снапшот сериализатора по ролям
      (п. 10), isolation-тест `projects`.

## Ссылки

- [`data-model.md`, группа 3 «Проекты», `taskCounter`, `visibility`](../../../docs/architecture/data-model.md)
- [`permission-model.md` §3.4 (`project:*` и требуемые уровни ACL)](../../../docs/security/permission-model.md)
- [`threat-model.md`, `T-PROJ-03`, `T-PROJ-05`](../../../docs/security/threat-model.md)
- [`ux-architecture.md`, «Проекты», «Формы»](../../../docs/architecture/ux-architecture.md)

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
