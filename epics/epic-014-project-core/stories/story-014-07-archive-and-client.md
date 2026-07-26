---
id: STORY-014-07
epic: EPIC-014
status: backlog
blocked: false
priority: should
estimate: M
---

# STORY-014-07 — Архивация проекта и связь с клиентом

**Как** руководитель проекта (P2) **я хочу** убирать завершённые проекты из повседневных списков,
сохраняя их содержимое доступным на чтение, и указывать, для какого заказчика ведётся проект,
**чтобы** рабочее пространство не заполнялось историей, а связь «проект → заказчик» существовала как
данные ещё до появления контрактов и денег в M9.

## Acceptance (Given/When/Then)

1. **Архивация.**
   Given участник с `project:archive` и уровнем `MANAGER`;
   When `POST /api/v1/projects/{projectId}/archive` с подтверждением;
   Then `status = ARCHIVED`; проект исчезает из списков и переключателя по умолчанию, остаётся
   доступным по прямой ссылке и через фильтр `status[]=ARCHIVED`; в `AuditLog` — `project.archived`.

2. **Архивный проект — только чтение.**
   Given архивный проект;
   When участник с `EDITOR` пытается изменить проект или создать в нём дочерний объект;
   Then 409 `project_archived`; правило проверяется **в policy**, а не в UI, и покрывает все
   изменяющие маршруты, где проект — предок (табличный тест).

3. **Восстановление.**
   Given архивный проект;
   When `POST /api/v1/projects/{projectId}/unarchive`;
   Then `status = ACTIVE`, доступ и права возвращаются в прежнее состояние (членство и ACL при
   архивации не удалялись); событие в `AuditLog`.

4. **Негативный сценарий — архивация без права.**
   Given участник с `EDITOR`, но без `project:archive`;
   When он архивирует проект;
   Then 403 `permission_not_granted`.

5. **Негативный сценарий — активная работа.**
   Given в проекте есть незакрытые задачи или незавершённые записи времени (когда эти домены
   появятся);
   When инициируется архивация;
   Then показывается сводка «что останется незакрытым», операция требует подтверждения, но не
   блокируется — архив не должен быть недостижим из-за одной забытой задачи.

6. **Связь с клиентом.**
   Given справочник клиентов-заглушка (`Client`: `name`, `slug`, `notes`) и право `client:read`;
   When в настройках проекта выбирается клиент;
   Then заполняется `Project.clientId`; на карточке проекта отображается имя клиента; запрос
   покрыт `idx_projects_org_client`.

7. **Границы задела под M9.**
   Given `Client` в M2;
   When проверяется скоуп;
   Then справочник содержит **только** идентификацию (имя, slug, заметка) — ни контрактов, ни
   ставок, ни NDA, ни платежей; эти домены появляются в
   [EPIC-041](../../epic-041-client-and-contract/epic.md) и
   [EPIC-042](../../epic-042-billing-and-budget/epic.md), и модель расширяется без переписывания
   связи «проект → клиент».

8. **Негативный сценарий — клиент без права.**
   Given пользователь без `client:read`;
   When он открывает настройки проекта;
   Then поле клиента отсутствует в форме и в ответе API; попытка задать `clientId` напрямую даёт
   403 `permission_not_granted`.

9. **Негативный сценарий — чужой клиент.**
   Given `clientId` организации B;
   When он подставляется в `PATCH`;
   Then **404** `resource_not_found`.

10. **Удаление клиента.**
    Given клиент привязан к проектам;
    When вызывается `client:delete` (`dangerous`);
    Then операция отклоняется с перечнем проектов либо (по подтверждению) обнуляет `clientId` в
    одной транзакции с записью в `AuditLog`; проекты при этом не удаляются.

11. **a11y и i18n.**
    Given диалоги архивации/восстановления и поле выбора клиента;
    When они проверяются axe и с клавиатуры;
    Then 0 нарушений A/AA, подтверждение разрушающего действия описывает последствия,
    все строки — EN и RU.

## Задачи

- [ ] `packages/server/src/application/project/use-cases/archive-project.use-case.ts`,
      `unarchive-project.use-case.ts`.
- [ ] `packages/server/src/domain/project/access/project-access.policy.ts` — ветка
      `assertNotArchived` для всех изменяющих операций проекта и его дочерних сущностей.
- [ ] `packages/server/prisma/migrations/*_clients_stub/migration.sql` — таблица `clients`
      (`name`, `slug`, `notes`, `deleted_at`), `uq_clients_org_slug`, FK
      `projects.client_id → clients.id ON DELETE RESTRICT`, RLS `ENABLE` + `FORCE` + политики.
- [ ] `packages/server/src/application/client/use-cases/{create,update,delete}-client.use-case.ts`,
      `queries/list-clients.query.ts` (минимальный справочник).
- [ ] `packages/server/src/presentation/http/routes/registry.ts` — `project:archive`,
      `client:read/create/update/delete`.
- [ ] `packages/client/src/widgets/project-settings/project-settings.widget.tsx` +
      `ui/archive-project-dialog.component.tsx`, `ui/client-select.component.tsx` (под `<Can>`).
- [ ] `packages/client/src/units/client/{model,service,ui}` — минимальный юнит справочника.
- [ ] i18n: `packages/client/src/app/i18n/{en,ru}/project.json`, `client.json`.
- [ ] Тесты: `archive-project.use-case.spec.ts`, табличный `archived-project-blocks-writes.spec.ts`
      (п. 2), интеграционные п. 6, 8–10, isolation-тест `clients`.

## Ссылки

- [`data-model.md`, группа 3 (`Project.status`, `clientId`), группа 13 (клиенты и контракты — M9)](../../../docs/architecture/data-model.md)
- [`permission-model.md` §3.4 (`project:archive`), §3.16 (`client:*`)](../../../docs/security/permission-model.md)
- [`threat-model.md`, `T-PROJ-03` (доступ к архивированному/удалённому проекту)](../../../docs/security/threat-model.md)
- [`roadmap.md`, M9 — область руководителя проекта](../../../docs/product/roadmap.md)
- [`ux-architecture.md`, `/projects/$projectId/settings`, «Подтверждение разрушающих действий»](../../../docs/architecture/ux-architecture.md)

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
