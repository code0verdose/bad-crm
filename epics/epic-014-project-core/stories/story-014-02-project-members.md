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

> **Сверено с кодом 2026-09-06.** История написана 2026-07-26, до EPIC-011, EPIC-012 и журнала
> действий. Текст ниже оставлен как запись замысла; расхождения с деревом — здесь.
>
> **Пути и имена.**
> - `presentation/http/routes/registry.ts` не существует: реестр — `route-registry.factory.ts`
>   (`createRouteRegistry`) плюс `route-registry.types.ts` в
>   `packages/server/src/presentation/http/`. Так же поправлено в
>   [STORY-011-07](../../epic-011-rbac-permissions/stories/story-011-07-policy-layer.md), `:116-117`.
> - Каталога `application/<контекст>/queries/` не существует: чтения лежат рядом с командами в
>   `use-cases/` и различаются суффиксом — образцы `application/iam/use-cases/list-teams.query.ts`
>   и `get-team-detail.query.ts`. То есть `list-project-members.query.ts` ложится в
>   `application/project/use-cases/`.
> - Серверные тесты — `*.test.ts` в `packages/server/test/**`, а не `*.spec.ts` рядом с кодом;
>   `.spec.ts` носят только сценарии `packages/e2e`.
>
> **Утверждения, которых код не подтверждает.**
> - `domain/access/implicit-level.ts` **не существует**, и идентификатор `implicitLevel` не
>   встречается в `packages/` ни разу. Значит это не «добавить ветку `PROJECT` к существующему
>   файлу», а завести механизм целиком: таблица неявных уровней —
>   `docs/security/permission-model.md:1318-1332`, пятнадцать строк (ORGANIZATION, PROJECT, CHANNEL,
>   личный ресурс, guest), из них проектных шесть. Ветки `CHANNEL` и «личный ресурс» предмета не
>   имеют — эти домены M4 — и здесь **заглушек не получают**: реализуются проектные строки,
>   остальные заводит эпик своего домена.
> - `AuditLog`: каталог действий закрытый (`packages/shared/src/audit/audit-action.enums.ts`),
>   `project.*` в нём нет. `project.member_added` и события критериев 4, 5, 11 — расширение
>   закрытого каталога, отдельная строка работы, а не деталь use-case.
> - Кодов `last_project_lead_required` и `invalid_member` в
>   `packages/shared/src/errors/error-code.enums.ts` нет. Прецедент формы есть — `last_owner_required`
>   (`:138`) и `member_not_active` (`:190`) — но каталог закрытый и `code` это контракт: новый код
>   заводится решением, с переводом на обоих языках и записью в спеке. `permission_not_granted`
>   из критерия 6 — `DenyReason`, а не код ошибки, он существует.
> - Механизм `permissionsVersion` существует и работает (инкремент в той же транзакции — как в
>   офбординге и передаче владения), а **кеша прав, который он инвалидировал бы, на сервере нет и
>   не будет**: актор пересобирается на каждый запрос, кеш отвергнут по замеру 2026-09-06
>   (`application/iam/use-cases/build-actor.query.ts:30-42`). Критерий 4 от этого только выигрывает:
>   «действует со следующего запроса» держится по построению.
>
> **Чего история не называет, а гейты требуют.**
> - Первый `project:*`-маршрут обязан прийти **в том же коммите** с сентенциями
>   `permission.project.*` на EN и RU и с удалением строки `project` из `AWAITING_A_ROUTE`
>   (`packages/client/test/i18n/permission-descriptions.test.ts:59`) — гейт двусторонний и падает
>   и на отсутствующем переводе, и на устаревшей причине отсрочки.
> - `docs/api/openapi.yaml` сверяется со стеком Express в обе стороны
>   (`packages/server/test/contract/openapi.test.ts:166`): маршрут без записи в спеке роняет CI.
> - Таблица `project_members` обязана получить строку в
>   `infrastructure/persistence/prisma/tenant-tables.constant.ts` и фабрику в
>   `test/integration/db/row-factories.util.ts` (`satisfies Record<TenantTableName, …>`, `:414`) —
>   без них код **не компилируется**.

> **Серверная половина таблицы сделана 2026-09-06** (вместе с `projects`, первый шаг эпика;
> use-case'ов, policy, `implicitLevel`, маршрутов, спеки и клиента **нет**). Что и где:
> - `project_members` в миграции `20260906135656_projects_and_project_members`: составные FK
>   `(organization_id, project_id) → projects` и `(organization_id, user_id) → users` (оба
>   `CASCADE` на удаление, `NO ACTION` на обновление), `ck_project_members_role` по закрытому списку
>   `LEAD|MEMBER|REVIEWER|OBSERVER`, `ck_project_members_allocation` (`BETWEEN 0 AND 100`,
>   `DEFAULT 100`), `uq_project_members (project_id, user_id) WHERE left_at IS NULL`,
>   `idx_project_members_org_user`, `ENABLE` + `FORCE`, обе политики, явные `GRANT`;
> - порт `application/project/ports/project-member-repository.port.ts` и реализация
>   `infrastructure/persistence/prisma/project-member.repository.ts`: `roster` (живые; с
>   `includeLeft` — все), `membershipOf` (живая строка — источник будущего `implicitLevel`), `leads`
>   под `FOR UPDATE`, `subject` под `FOR SHARE`, `add` через `ON CONFLICT (project_id, user_id) WHERE
>   left_at IS NULL DO NOTHING`, `update`, `leave` (`SET left_at = now() … WHERE left_at IS NULL`).
>
> **Что держит база, а что остаётся сценарию** (проверено на реальном PostgreSQL в
> `test/integration/db/project-repository.test.ts`, блок «two requests race»):
> - двойное добавление одной пары — частичный уникальный индекс + `DO NOTHING`: одна строка, один
>   `true`, без ошибки; повторный `add` с другой ролью роль **не меняет** — повышение это `update`;
> - выход и возвращение — условная запись `left_at`, вторая попытка выхода `false`, повторное
>   вступление создаёт новую строку;
> - «последний лид» — правило use-case'а (критерий 7), но `leads()` держит живых лидов под
>   `FOR UPDATE`: два одновременных снятия двух лидов не могут оба насчитать «двоих», один остаётся.
>
> Инкремент `permissionsVersion` при смене состава (критерий 1) — в use-case следующего шага; метод
> `bumpPermissionsVersionOf` сегодня есть только у `TeamRepositoryPort`, и решение, выносить ли его в
> общий порт, принимается там, а не здесь.

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

- [x] `packages/server/prisma/migrations/20260906135656_projects_and_project_members/migration.sql` —
      `project_members` (`project_role`, `allocation_pct` + CHECK 0…100, `joined_at`, `left_at`),
      составной FK `(organization_id, project_id)`, `uq_project_members (project_id, user_id) WHERE left_at IS NULL`,
      `idx_project_members_org_user`, RLS `ENABLE` + `FORCE` + политики; порт и репозиторий
      `project-member-repository.port.ts` / `project-member.repository.ts` (2026-09-06).
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
      isolation-тест `project_members` — [x] реестровый набор `rls-isolation.test.ts` плюс
      `project-repository.test.ts` (2026-09-06).

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
