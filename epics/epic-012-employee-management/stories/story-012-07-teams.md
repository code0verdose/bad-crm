---
id: STORY-012-07
epic: EPIC-012
status: backlog
blocked: false
priority: should
estimate: M
---

# STORY-012-07 — Команды как субъект ACL

**Как** администратор системы (P5) **я хочу** объединять сотрудников в команды и выдавать доступ
сразу команде, **чтобы** при найме нового бэкендера не обходить двадцать проектов и папок вручную,
а при переводе человека доступ менялся вместе с его составом команд.

## Acceptance (Given/When/Then)

1. **CRUD команды.**
   Given администратор с `team:create`;
   When `POST /api/v1/teams` с `{ name, slug, description, leadId }`;
   Then создаётся `Team`; `slug` уникален внутри организации; в `AuditLog` — `team.created`.

2. **Управление составом.**
   Given команда и сотрудник;
   When `POST /api/v1/teams/{teamId}/members` (право `team:manage_members`);
   Then создаётся `TeamMember(teamRole = MEMBER|LEAD)`, инкрементится `permissions_version`
   **этого пользователя** в той же транзакции; `uq_team_members (team_id, user_id)` не допускает
   дублей.

3. **Команда — субъект ACL.**
   Given `ResourceAcl(PROJECT, USER=none, subjectType = TEAM, subjectId = backend, EDITOR)`;
   When Иван добавляется в команду backend;
   Then он немедленно (после инвалидации версии) получает уровень `EDITOR` на этот проект без
   создания персональной записи ACL.

4. **Выход из команды отбирает доступ.**
   Given Иван в команде backend с доступом через ACL команды;
   When он удаляется из команды;
   Then `permissions_version` инкрементится, `resolveAcl` перестаёт учитывать эту запись (субъект
   больше не совпадает), доступ пропадает на следующем запросе; проверяется интеграционным тестом
   «удаление из команды закрывает проект».

5. **Удаление команды.**
   Given команда с 5 участниками и 3 записями `ResourceAcl`;
   When `DELETE /api/v1/teams/{teamId}`;
   Then в одной транзакции удаляются `TeamMember` и все `ResourceAcl` с
   `subjectType = TEAM, subjectId = teamId`, версия инкрементится всем бывшим участникам одним
   `UPDATE`; в `AuditLog` — `team.deleted` + `acl.revoked` по каждой снятой записи.

6. **Максимум на одном узле.**
   Given на проекте есть `TEAM=backend → EDITOR` и `USER=ivan → VIEWER`, Иван в backend;
   When резолвится уровень;
   Then `EDITOR` (максимум на одном узле); понизить конкретного человека можно только `NONE` или
   записью на более близком узле.

7. **Негативный сценарий — команда чужой организации.**
   Given `teamId` из организации B;
   When администратор организации A добавляет туда участника;
   Then **404** `resource_not_found`.

8. **Негативный сценарий — нет права.**
   Given пользователь без `team:manage_members`;
   When он меняет состав;
   Then 403 `permission_not_granted`; кнопка в UI отсутствует (гарды через `<Can>`).

9. **Негативный сценарий — деактивированный участник.**
   Given сотрудник деактивирован;
   When он числится в команде;
   Then он не даёт доступа: сборка `Actor` невозможна для `SUSPENDED`, а офбординг удаляет
   `TeamMember` (см. [STORY-012-05](story-012-05-offboarding.md)).

10. **Команда — не группа доступа.**
    Given документация и UI;
    When пользователь читает подсказку;
    Then явно сказано, что `Team` — оргструктурная сущность; отдельные группы доступа
    (`subjectType = GROUP`) — открытый вопрос №3 §12 `permission-model.md` и в M2 не вводятся.

## Задачи

- [ ] `packages/server/prisma/migrations/*_teams/migration.sql` — `teams` (`name`, `slug`,
      `description`, `lead_id`, `deleted_at`), `team_members` (`team_role`, `joined_at`),
      `uq_team_members (team_id, user_id)`, `idx_team_members_org_user`, уникальный slug внутри
      организации, RLS `ENABLE` + `FORCE` + политики.
- [ ] `packages/server/src/application/iam/use-cases/create-team.use-case.ts`,
      `update-team.use-case.ts`, `delete-team.use-case.ts`, `manage-team-members.use-case.ts`.
- [ ] `packages/server/src/application/iam/queries/list-teams.query.ts`,
      `get-team-detail.query.ts` (состав + число записей ACL, где команда — субъект).
- [ ] `packages/server/src/domain/iam/access/team-access.policy.ts`.
- [ ] Инкремент `permissionsVersion` всем членам при изменении состава и при удалении команды —
      один `UPDATE ... WHERE id IN (...)`, без цикла в приложении.
- [ ] `packages/server/src/presentation/http/routes/registry.ts` — `team:read/create/update/delete/manage_members`.
- [ ] `packages/client/src/units/team/{model,service,ui}` + `widgets/team-list/team-list.widget.tsx`,
      `widgets/team-detail/team-detail.widget.tsx`.
- [ ] Тесты: `team-access.policy.spec.ts`, интеграционные `team-acl-propagation.spec.ts` (п. 3, 4),
      `delete-team-cascades-acl.spec.ts` (п. 5), isolation-тесты `teams` и `team_members`.

## Ссылки

- [`permission-model.md` §2 «Слой 4», субъекты `USER | ROLE | TEAM`](../../../docs/security/permission-model.md)
- [`permission-model.md` §5, краевой случай 12; §8 «Что инкрементит permissionsVersion»](../../../docs/security/permission-model.md)
- [`permission-model.md` §12, открытый вопрос №3 (группы вместо команд)](../../../docs/security/permission-model.md)
- [`data-model.md`, группа 1, `Team`, `TeamMember`](../../../docs/architecture/data-model.md)
- [`permission-model.md` §3.1 (`team:*`)](../../../docs/security/permission-model.md)

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
