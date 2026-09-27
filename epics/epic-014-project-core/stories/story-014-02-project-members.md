---
id: STORY-014-02
epic: EPIC-014
status: in-progress
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
> use-case'ов, policy, `implicitLevel`, маршрутов, спеки и клиента на тот день **не было** —
> `implicitLevel` для `PROJECT` пришёл в тот же день с STORY-011-06, use-case'ы, policy, маршруты и
> спека закрыты 2026-09-10, см. врезку пятого шага ниже; открыт только клиент). Что и где:
> - `project_members` в миграции `20260906135656_projects_and_project_members`: составные FK
>   `(organization_id, project_id) → projects` и `(organization_id, user_id) → users` (оба
>   `CASCADE` на удаление, `NO ACTION` на обновление), `ck_project_members_role` по закрытому списку
>   `LEAD|MEMBER|REVIEWER|OBSERVER`, `ck_project_members_allocation` (`BETWEEN 0 AND 100`,
>   `DEFAULT 100`), `uq_project_members (project_id, user_id) WHERE left_at IS NULL`,
>   `idx_project_members_org_user`, `ENABLE` + `FORCE`, обе политики, явные `GRANT`;
> - порт `application/project/ports/project-member-repository.port.ts` и реализация
>   `infrastructure/persistence/prisma/project-member.repository.ts`: `roster` (живые; с
>   `includeLeft` — все), `membershipOf` (живая строка — источник будущего `implicitLevel`), `leads`
>   под `FOR UPDATE`, `subject` под `FOR SHARE` (с 2026-09-11 — под `FOR NO KEY UPDATE`: замер гонки
> «один человек в два проекта разом» показал share-lock upgrade на строке `users`, см. врезку пятого
> шага ниже), `add` через `ON CONFLICT (project_id, user_id) WHERE
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
> общий порт, принимается там, а не здесь. *(Закрыто 2026-09-10: метод получил
> `ProjectMemberRepositoryPort` над общим `permissions-version.util.ts` — как у команд и, с `245d601`,
> у ACL; см. врезку пятого шага ниже.)*

> **Серверная и HTTP-половины сделаны 2026-09-10** (пятый шаг эпика). Что и где:
> - use-case'ы `application/project/use-cases/manage-project-members.use-case.ts`
>   (`AddProjectMemberUseCase`, `UpdateProjectMemberUseCase`, `RemoveProjectMemberUseCase`) и
>   `list-project-members.query.ts`; все три команды держат строку проекта под `FOR UPDATE`
>   (`project-write-facts.util.ts`), «последний лид» считается по `leads()` под `FOR UPDATE`;
> - policy `domain/project/access/project-membership.policy.ts`: `assertNotSelfJoin` (403
>   `self_assignment_forbidden`, `T-PROJ-02`), `assertLastLeadKept` (409
>   `last_project_lead_required`), `assertProjectSubjectJoinable` (404 чужой, 409
>   `member_not_active` только держателю `user:read`);
> - маршруты: `GET /projects/{projectId}/members` (`project:read`, `?includeLeft=true`),
>   `POST …/members` (`project:manage_members`, `Idempotency-Key`), `PATCH`/`DELETE
>   …/members/{userId}` (`project:manage_members`); каждый с `aclCheckedIn`, операцией в спеке и
>   строками в снапшоте матрицы;
> - `permissionsVersion` инкрементится в той же транзакции при любом изменении членства —
>   `ProjectMemberRepositoryPort.bumpPermissionsVersionOf` над общим `permissions-version.util.ts`
>   (решение «вынести в общий порт» принято так же, как у команд и ACL: свой метод на порт, одна
>   инструкция на всех);
> - `implicitLevel` для `PROJECT` уже был в `domain/access/implicit-level.policy.ts` (STORY-011-06),
>   отдельного `domain/access/implicit-level.ts` не заводилось;
> - журнал: `project.member_added`/`member_removed`/`member_role_changed` — `WARNING`, потому что
>   членство в проекте, в отличие от команды, и есть неявный уровень доступа; описание
>   `permission.project.manage_members` на EN и RU.
>
> **Решения по критериям, принятые здесь.**
> - Критерий 7: код **`last_project_lead_required`** заведён (409): `last_owner_required` советует
>   передать владение организацией, а здесь следующий шаг — назначить другого лида.
> - Критерий 8: `invalid_member` не заводился — отключённый участник это `409 member_not_active`
>   (формулировка на клиенте обобщена на команду и проект), чужой — `404 user_not_found`.
> - Критерий 4: смена роли пишется в журнал и инкрементит версию; смена одной `allocationPct` —
>   применяется без записи и без инкремента (прав не двигает). Свою роль менять нельзя ни в какую
>   сторону (`403 self_assignment_forbidden`) — правило самоприсоединения из критерия 6
>   распространено на все три пути, пишущие уровень места (`POST …/members`, `leadId` в
>   `PATCH /projects/{id}`, `projectRole` в `PATCH …/members/{userId}`); своя доля — можно.
> - Повторный `POST` для человека, который уже в проекте, читается как у команд (гейт L-3
>   STORY-012-07): та же роль и доля — тихий 204; другая роль — смена роли с записью и правилом
>   последнего лида; другая доля — применяется тихо.
> - Критерий 5: выход — `left_at`, строка остаётся; удаление проекта участников не выводит
>   (проект скрыт, цепочка `missing`).
>
> **Чего здесь нет:** клиентских `units/project/service/*`, `widgets/project-members` и
> `membership-invalidates-permissions` e2e — клиентская половина; суммарная загрузка по проектам как
> подсказка UI (критерий 9) — там же.

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
- [x] `packages/server/src/application/project/use-cases/manage-project-members.use-case.ts` —
      три команды одним файлом, по образцу `manage-team-members.use-case.ts` (2026-09-10).
- [x] `packages/server/src/domain/project/access/project-membership.policy.ts` —
      `assertNotSelfJoin`, `assertLastLeadKept`, `assertProjectSubjectJoinable`;
      `canManageProjectMembers` — в `project-access.policy.ts` рядом с остальными решениями
      (2026-09-10).
- [x] `packages/server/src/domain/access/implicit-level.policy.ts` — ветка `PROJECT` пришла с
      [STORY-011-06](../../epic-011-rbac-permissions/stories/story-011-06-resource-acl.md) 2026-09-06.
- [x] `packages/server/src/application/project/use-cases/list-project-members.query.ts` (2026-09-10).
- [x] Инкремент `permissionsVersion` при любом изменении членства — в той же транзакции
      (`bumpPermissionsVersionOf` на `ProjectMemberRepositoryPort`, 2026-09-10).
- [x] `packages/server/src/presentation/http/route-registry.factory.ts` — `project:manage_members`,
      `project:read` c `aclCheckedIn` (2026-09-10).
- [x] Клиент (2026-09-27; пути от `packages/client/src/`): раздел `/projects/$projectId/members`
      (`app/routes/_authenticated/projects/$projectId/members.tsx`, `pages/project/members-page.tsx`,
      `widgets/project-members`); мутации `add-project-member` (**пессимистичная**, а не
      «оптимистичный патч» плана: `204` без строки, а реальные отказы — сам себя, отключённый
      аккаунт — ровно те случаи, где оптимистичная строка показала бы доступ, которого нет),
      `update-project-member` и `remove-project-member` — **оптимистичные** (inline-правка и удаление,
      `runOptimisticPatch`/`runOptimisticRemove` с `idKey: 'userId'` — хелпер научен адресовать строку
      не по `id`; откат снапшотом на прежнее место); хук `use-project-roster.hook.ts`; компоненты
      `units/project/ui/project-member-{table,add-form}.component.tsx` (роль — `NativeSelect` в строке,
      доля — `NumberInput` 0…100 с `clampBehavior="strict"`). Отказы — один тост с текстом по
      `reason` (`units/project/lib/utils/project-refusal.util.ts`); кандидаты без участников и без
      читающего (`self_assignment_forbidden`). Управление составом рисуется только по
      `permissions.canManageMembers`.

> **Открыто по клиенту (2026-09-27).** Критерий 10 — фильтры `q`, `role[]` и «вышедшие» в URL:
> не сделаны, список показывает живой состав целиком. Критерий 9 — суммарная загрузка сотрудника по
> проектам как подсказка: не сделана (нужен источник по всем проектам человека). E2E
> `membership-invalidates-permissions.spec.ts` не написан.
- [x] Тесты сервера: `test/unit/domain/project/project-membership-policy.test.ts` (п. 6, 7),
      `implicit-level-policy.test.ts` (п. 2, 3, с STORY-011-06),
      `test/unit/application/manage-project-members.use-case.test.ts`,
      HTTP `test/integration/http/project-member-endpoints.test.ts` (п. 1, 4, 5, 8, 9, 10);
      гонки на живом PostgreSQL настоящими use-case'ами —
      `test/integration/db/project-roster-races.test.ts` (два лида уходят одновременно → ровно
      один `409 last_project_lead_required`; двойное добавление → одна строка, один инкремент,
      одна запись; правка во время удаления → либо успела, либо тот же `404`; один человек в два
      разных проекта разом → обе строки, без deadlock на строке `users` — этот кейс был красным и
      сменил блокировку `subject()` с `FOR SHARE` на `FOR NO KEY UPDATE`; у каждой гонки
      последовательный контроль), потому что HTTP-набор стоит на in-memory-двойниках и гонку
      измерить не может;
      isolation-тест `project_members` — реестровый набор `rls-isolation.test.ts` плюс
      `project-repository.test.ts` (2026-09-06). Открыто: e2e
      `membership-invalidates-permissions.spec.ts` (доступ меняется без перелогина) — с клиентской
      половиной.

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
