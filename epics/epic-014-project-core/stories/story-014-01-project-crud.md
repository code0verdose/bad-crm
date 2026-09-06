---
id: STORY-014-01
epic: EPIC-014
status: in-progress
blocked: false
priority: must
estimate: M
---

# STORY-014-01 — Создание и редактирование проекта

**Как** руководитель проекта (P2) **я хочу** завести проект с человекочитаемым ключом, статусом,
видимостью, лидом и сроками, **чтобы** появилось пространство, к которому дальше пристёгиваются
задачи, документы, файлы и часы.

> **Сверено с кодом 2026-09-06.** История написана 2026-07-26, до EPIC-011, EPIC-012, EPIC-013 и
> журнала действий. Текст ниже оставлен как запись замысла; расхождения с деревом — здесь.
>
> **Пути и имена.**
> - `presentation/http/routes/registry.ts` не существует. Реестр — это
>   `packages/server/src/presentation/http/route-registry.factory.ts` (`createRouteRegistry`,
>   `satisfies readonly RouteDeclaration[]` на `:348`) плюс форма объявления в
>   `route-registry.types.ts`. То же расхождение закрыто в
>   [STORY-011-07](../../epic-011-rbac-permissions/stories/story-011-07-policy-layer.md), состав, `:116-117`.
> - Серверные тесты называются `*.test.ts` и лежат отдельным деревом в `packages/server/test/**`
>   (`unit/`, `integration/`, `contract/`, `permissions/`); `*.spec.ts` носят только сценарии
>   `packages/e2e`. Имена в составе ниже читать с этой поправкой.
> - Локали клиента лежат в `packages/client/src/shared/i18n/locales/{en,ru}/`, каталога
>   `src/app/i18n/` нет.
> - `infrastructure/persistence/prisma/soft-delete.extension.ts` не существует, и единственный
>   `$extends` во всём дереве — `tenant-guard.adapter.ts:59`. Само требование мягкого удаления верно
>   (`data-model.md`, «Мягкое удаление»; флаг `softDeleted` в `tenant-tables.constant.ts`), но
>   критерий 11 — работа с нуля, а не подключение к существующему механизму.
>
> **Утверждения, которых код не подтверждает.**
> - `AuditLog`: каталог действий закрытый (`packages/shared/src/audit/audit-action.enums.ts`), и
>   `project.*` в нём нет ни одного — для сравнения, `team.*` есть пять. Значит `project.created`,
>   `project.updated` и `project.visibility_changed` — **расширение закрытого каталога**, отдельная
>   строка работы с докстрингом на каждое действие, а не деталь реализации use-case.
> - Кодов `project_key_taken`, `project_key_immutable`, `invalid_lead` в
>   `packages/shared/src/errors/error-code.enums.ts` нет. Есть сгенерированная тройка
>   `project_not_found` / `project_forbidden` / `project_already_exists` (`project` входит в
>   `ERROR_RESOURCES`, `:30`). Каталог закрытый, `code` — контракт, который не переименовывают:
>   каждый новый код это отдельное решение, перевод на обоих языках и запись в спеке.
>   `permission_not_granted` и `insufficient_acl_level` из критериев 5 и 6 — это `DenyReason`
>   (`packages/shared/src/permissions/deny-reason.enums.ts:22,32`), а не коды ошибок; они есть.
> - Критерии 5 и 6 предполагают, что отказ по ACL различим в снапшоте матрицы прав. Сегодня
>   **каждая ячейка снапшота — capability-решение**: `requiredLevel` равен `null` у всех ключей,
>   стоящих на маршрутах, и докстринг снапшота говорит это прямо
>   (`packages/server/test/permissions/permission-matrix.test.ts:29-33`). У `project:*` в каталоге
>   уровни проставлены (`project:update` — `EDITOR`, `project:delete` и `project:manage_visibility` —
>   `MANAGER`, оба `dangerous`), поэтому первый же `project:*` на маршруте делает снимок
>   двумерным: снапшот придётся переснять и, возможно, добавить ось ресурса.
>
> **Чего история не называет, а гейты требуют.**
> - **Описания прав.** `packages/client/test/i18n/permission-descriptions.test.ts` работает в обе
>   стороны: требует сентенцию для каждого ключа, объявленного маршрутом, **и запрещает** её для
>   ключа без маршрута; плюс роняет сборку на строке `AWAITING_A_ROUTE`, переставшей быть правдой, —
>   а `project` там стоит (`:59`). Значит первый `project:*`-маршрут обязан прийти **в том же
>   коммите** с `permission.project.*` на EN и RU и с удалением строки `project` из
>   `AWAITING_A_ROUTE`.
> - **Контракт.** `docs/api/openapi.yaml` сверяется со стеком Express в обе стороны
>   (`packages/server/test/contract/openapi.test.ts:166`) — маршрут без записи в спеке роняет CI, и
>   наоборот. Плюс `error-codes.test.ts`, `validated-operations.test.ts`, `acl-coverage.test.ts`.
> - **Реестр таблиц арендатора.** Новая таблица обязана получить строку в
>   `packages/server/src/infrastructure/persistence/prisma/tenant-tables.constant.ts` и фабрику
>   строки в `packages/server/test/integration/db/row-factories.util.ts` (`TENANT_ROW_FACTORIES`
>   закреплён `satisfies Record<TenantTableName, TenantRowFactory>`, `:414`). Без этих двух записей
>   код **не компилируется** — это не «не забыть», а условие сборки.

> **Серверная половина таблиц сделана 2026-09-06** (первый шаг эпика; use-case'ов, маршрутов,
> спеки, сериализатора и клиента **нет**). Что и где:
> - миграция `packages/server/prisma/migrations/20260906135656_projects_and_project_members/` —
>   `projects` и `project_members` одним expand-шагом: `organization_id NOT NULL`, составные FK
>   `(organization_id, lead_id) → users` (`NO ACTION` в обе стороны, как владелец организации),
>   `CHECK` вместо PG-enum на `status`/`visibility`/`project_role`, `ck_projects_key_format`
>   (`^[A-Z][A-Z0-9]{1,9}$` — ключ хранится **уже нормализованным**, нормализацию делает value-object
>   этой истории, база отказывает всему остальному), `uq_projects_org_key … WHERE deleted_at IS NULL`,
>   `idx_projects_org_status … WHERE deleted_at IS NULL`, `idx_projects_org_lead`, `ENABLE` + `FORCE`,
>   обе политики с идентичными `USING`/`WITH CHECK`, явные `GRANT`, `GRANT SELECT … TO backup_role`;
> - Prisma-модели `Project`/`ProjectMember`, записи в `tenant-tables.constant.ts` и фабрики в
>   `row-factories.util.ts` — обе таблицы проходят реестровый isolation-набор с положительным
>   контролем на чтение, список, счётчик, вставку, правку и удаление своей строки;
> - `domain/project/project.enums.ts` (закрытые списки; юнит-тест сверяет их с `CHECK` миграции) и
>   `project.entity.ts` (`ProjectScope` с `visibility`, `ProjectSubject`, `ProjectMembership`);
> - порт `application/project/ports/project-repository.port.ts` и реализация
>   `infrastructure/persistence/prisma/project.repository.ts` (`list`, `scope` под `FOR SHARE`,
>   `detail`, `create`, `update`, `changeVisibility`, `changeStatus`, `softDelete` одним условным
>   оператором); тесты — `test/unit/persistence/project-repository.test.ts` и
>   `test/integration/db/project-repository.test.ts`.
>
> **Два расхождения с моделью данных, решённые здесь и записанные в `data-model.md` §3.**
> - `clientId` и `idx_projects_org_client` **отложены до STORY-014-07**: таблицы `clients` нет,
>   `client` нет в `ERROR_RESOURCES`, а uuid-колонка без составного FK — ссылка, которую никто не
>   проверяет (`rules/tenancy-rls.mdc`, 7). Nullable-колонка добавляется позже чистым expand-шагом.
> - Критерий 11 говорит о фильтре `deletedAt IS NULL` через Prisma-`$extends`; механизма в дереве
>   нет (см. выше), и фильтр сделан **явным в репозитории**: список фильтрует в SQL, чтение по id —
>   нет (решение о 404 для удалённого проекта принимает policy, как у команд), юнит-тест держит это
>   на каждом методе. Табличного теста `soft-deleted-invisible-in-all-repositories` не будет — вместо
>   него проверка в каждом репозитории по месту.
>
> Ошибка уникальности ключа сегодня отдаётся как `project_already_exists` (тройка из
> `ERROR_RESOURCES`); `project_key_taken` из критерия 2 — по-прежнему отдельное решение по каталогу.

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

- [x] `packages/server/prisma/migrations/20260906135656_projects_and_project_members/migration.sql` —
      таблица `projects` (`key`, `name`, `description`, `status`, `visibility`, `lead_id`,
      `started_at`, `due_at`, `color`, `task_counter`, `deleted_at`; `client_id` и
      `idx_projects_org_client` — в STORY-014-07 вместе с `clients`),
      `uq_projects_org_key ... WHERE deleted_at IS NULL`, `idx_projects_org_status ... WHERE deleted_at IS NULL`,
      RLS `ENABLE` + `FORCE` + `tenant_isolation` (USING = WITH CHECK) + `maintenance_access`.
- [ ] `packages/server/src/domain/project/project.entity.ts`, `project.errors.ts`,
      `project-key.value.ts` (нормализация и формат).
- [ ] `packages/server/src/application/project/use-cases/create-project.use-case.ts`,
      `update-project.use-case.ts`, `change-project-visibility.use-case.ts`,
      `delete-project.use-case.ts`.
- [x] `packages/server/src/application/project/ports/project-repository.port.ts` + реализация
      `infrastructure/persistence/prisma/project.repository.ts` (2026-09-06).
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
      (п. 10); isolation-тест `projects` — [x] реестровый набор `rls-isolation.test.ts` плюс
      `project-repository.test.ts` (2026-09-06).

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
