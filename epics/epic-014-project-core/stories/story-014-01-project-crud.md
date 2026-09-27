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

> **Серверная и HTTP-половины сделаны 2026-09-10** (пятый шаг эпика). Что и где:
> - use-case'ы `application/project/use-cases/`: `create-project.use-case.ts`,
>   `update-project.use-case.ts`, `change-project-visibility.use-case.ts`,
>   `archive-project.use-case.ts`, `delete-project.use-case.ts`; общие факты записи —
>   `application/project/project-write-facts.util.ts` (строка под `FOR UPDATE` плюс цепочка ACL,
>   читаются один раз на команду);
> - policy: именованные решения `canCreateProject`/`canUpdateProject`/`canManageProjectVisibility`/
>   `canArchiveProject`/`canDeleteProject`/`canManageProjectMembers` в
>   `domain/project/access/project-access.policy.ts`; value-object `domain/project/project-key.value.ts`
>   (нормализация `trim` + upper-case, паттерн сверяется с `ck_projects_key_format` тестом);
> - маршруты в `route-registry.factory.ts`: `POST /projects` (`project:create`),
>   `PATCH /projects/{projectId}` (`project:update`, при смене `leadId` — ещё и
>   `project:manage_members`), `POST …/visibility` (`project:manage_visibility`, `X-Confirm-Dangerous`),
>   `POST …/archive` (`project:archive`), `DELETE …` (`project:delete`); каждый с `aclCheckedIn`,
>   операцией в `docs/api/openapi.yaml` и переснятым снапшотом матрицы;
> - репозиторий: `lockForWrite()` под `FOR UPDATE` — писатель строки не берёт `FOR SHARE` из
>   `scope()`, иначе две правки одного проекта дедлочатся на апгрейде блокировки; **замерено** на
>   живом PostgreSQL в `test/integration/db/project-write-locks.test.ts`;
> - журнал: `project.created`/`updated`/`archived` (`INFO`), `project.visibility_changed`/`deleted`
>   (`WARNING`, за опасными ключами), ресурс `PROJECT`;
> - описания `permission.project.{create,update,manage_visibility,archive,delete}` на EN и RU.
>
> **Решения по критериям, принятые здесь.**
> - Критерий 2: `project_key_taken` не заводился — это `409 project_already_exists` из тройки
>   `ERROR_RESOURCES`.
> - Критерий 4: `project_key_immutable` не заводился — `key` отсутствует в схеме редактирования
>   (`strictObject`), и `PATCH` с `key` отвечает `422 validation_failed` с `errors[0].path = 'key'`,
>   `code = 'unrecognized_keys'`.
> - Критерий 7: подтверждение — `X-Confirm-Dangerous: 1` / `428 confirmation_required`, спрашивается
>   **после** решения о доступе; сводка «сколько сотрудников потеряет доступ» — клиентская
>   (STORY-014-05), сервер её не считает. Переиндексация — задел под M4, здесь ничего не делает.
> - Критерий 9: `invalid_lead` не заводился — чужой лид это `404 user_not_found`, отключённый —
>   `409 member_not_active` (для держателя `user:read`, иначе тот же 404): те же два факта, что у
>   участника, и третий код для них был бы третьей фразой на клиенте.
> - Смена лида в `PATCH` требует `project:manage_members` сверх `project:update`: новый лид
>   получает `LEAD`-членство (`MANAGER`), и `EDITOR`, раздающий его через форму переименования,
>   был бы эскалацией (`rules/permissions.mdc`, 10). Прежний лид своё место сохраняет. Назначить
>   лидом **себя** нельзя ни с каким ключом (`403 self_assignment_forbidden`) — иначе `MANAGER` по
>   истекающему ACL-гранту становился бы постоянным `LEAD`-членством (находка `security-auditor`
>   на первом черновике, закрыта тем же гейтом).
> - **Принятый остаточный риск (переформулирован 2026-09-11 по второму проходу
>   `security-auditor`):** `409 project_already_exists` на `POST /projects` подтверждает, что ключ
>   занят, даже когда держатель — `PRIVATE`-проект, невидимый вызывающему. Это свойство модели
>   (ключ — префикс номеров задач, уникален в организации). Первая редакция называла
>   компенсирующим контролем «лимит частоты» — **его на этом маршруте нет**: бюджет `api_request`
>   тратят три use-case'а `identity`, и никакой middleware его не монтирует
>   (`application/platform/ports/rate-limit.port.ts`). Что ограничивает риск на самом деле:
>   право `project:create` держат три системные роли (`owner`, `admin`, `manager`); попадание
>   стоит ровно одну догадку о ключе длиной 2–10 символов и не раскрывает ничего, кроме факта
>   занятости; промах — не бесплатен, он создаёт проект (в той видимости, какую вызывающий
>   задал) с вызывающим в роли `LEAD` и строкой `project.created` в журнале.
>   Известное свойство, которое **не** компенсируется ничем: попадание следа не оставляет —
>   `ConflictError` не есть `DenyReason`, `access.denied` не пишется, `project.created` тоже.
>   Оценка Low сохранена; в код не переносится. Если след на попадании понадобится, дешевле всего
>   писать `project_already_exists` этого маршрута в журнал, а не заводить лимитер.
> - Критерий 10 (финансовые поля) — сериализатор их не знает, полей нет в схеме; критерий 11 —
>   мягкое удаление сделано явным `deleted_at` в репозитории, `$extends` не появился (см. врезку выше).
>
> **Чего здесь нет:** клиентской формы (`units/project`, `widgets/project-form`) и i18n-namespace
> `project.json` — клиентская половина истории; списка и `visibleProjectIds` (STORY-014-03/04).

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
- [x] `packages/server/src/domain/project/project.entity.ts`, `project-key.value.ts`
      (нормализация и формат) — 2026-09-10; `project.errors.ts` не понадобился: свои коды ошибок у
      проекта только `last_project_lead_required` (STORY-014-02), остальное выражено существующими.
- [x] `packages/server/src/application/project/use-cases/create-project.use-case.ts`,
      `update-project.use-case.ts`, `change-project-visibility.use-case.ts`,
      `archive-project.use-case.ts`, `delete-project.use-case.ts` (2026-09-10).
- [x] `packages/server/src/application/project/ports/project-repository.port.ts` + реализация
      `infrastructure/persistence/prisma/project.repository.ts` (2026-09-06).
- [x] `packages/server/src/presentation/http/serializers/project.serializer.ts` — базовый уровень
      и участник; финансового уровня нет, потому что нет финансовых полей (M9).
- [x] `packages/server/src/presentation/http/validators/project.validator.ts` — `strictObject`,
      `.transform` для `key`, `.superRefine` для дат (2026-09-10).
- [x] `packages/server/src/presentation/http/route-registry.factory.ts` — `project:create/update/
      delete/manage_visibility/archive` c `aclCheckedIn` (2026-09-10).
- [x] Клиент (2026-09-27; пути от `packages/client/src/`, где разошлось с планом — причина в строке):
      схема `units/project/model/validation/project-form.schema.ts` (`projectFormSchema` и
      `projectEditFormSchema` через `.omit`, правило дат на `dueAt`); мутации
      `units/project/service/mutations/{create-project,update-project,change-project-visibility,archive-project,delete-project}.mutation.ts`
      — все пессимистичные, с локальным `onError` (ошибка живёт в форме или в `aria-modal`-диалоге);
      хуки `use-project-{creation,editing,visibility-change,archival,deletion,controls}.hook.ts`;
      форма `units/project/ui/project-form.component.tsx` (одна на создание и правку — вместо
      `widgets/project-form`); серверные ошибки полей — `units/project/lib/utils/project-form-failure.util.ts`
      (`409 project_already_exists` → ключ, `404 user_not_found`/`409 member_not_active`/причина
      `self_assignment_forbidden` → лид, `422 errors[].path` → своё поле); экран создания
      `/projects/new` (`app/routes/_authenticated/projects/new.tsx`, `pages/project-new`,
      `widgets/project-create`, гард `project:create`); раздел настроек
      `/projects/$projectId/settings` (`widgets/project-settings`: правка, видимость, архив, удаление
      через один `ProjectConfirmDialog`).
- [x] i18n: `shared/i18n/locales/{en,ru}/projects.json` (namespace `projects`, не `project`).

> **Клиентская половина — решения и открытое (2026-09-27).**
> - Даты — календарные дни в UTC (конвенция `units/iam/lib/utils/override-expiry.util.ts`).
> - Палитра цвета — только измеренные семейства темы (`brand/info/success/warning/danger/neutral`):
>   сырые оттенки Mantine запрещены `bad-crm/no-raw-mantine-color` (контраст AA). Сохранённый цвет
>   вне палитры остаётся выбираемым, чтобы `PATCH` не перекрасил проект молча.
> - Видимость подтверждается диалогом, и единственный запрос уходит сразу с
>   `X-Confirm-Dangerous: 1` — двухшаговый `428` нужен клиенту, который последствий не показал.
> - **Критерий 7, сводка «сколько сотрудников потеряет доступ» — не сделана:** сервер её не считает,
>   а клиентский подсчёт требует справочника (`user:read`) и не видит явных грантов ACL; диалог
>   называет последствия словами.
> - **Разрыв контракта: серверная половина закрыта 2026-09-27, клиент ждёт.** `ProjectPermissions`
>   получил обязательный флаг `canChangeVisibility` — решение `canManageProjectVisibility`, той же
>   функции, что ассертит `ChangeProjectVisibilityUseCase` (`project-permissions.policy.ts`, таблица
>   `test/unit/application/project-card-permissions.test.ts`; разбор — STORY-014-05). Клиент пока
>   рисует кнопку по одной capability `project:manage_visibility` (`useCan().holds`), без уровня
>   `MANAGER`: держателю ключа без уровня кнопка видна, а отказ приходит в диалоге. Открыто —
>   переключить кнопку на флаг.
> - Удалённый проект уводит на дашборд: маршрута `/projects` (STORY-014-04) в этой ветке нет.
- [x] Тесты: `test/unit/domain/project/project-key-value.test.ts`,
      `project-access-policy.test.ts` (п. 5, 6), use-case'ы в `test/unit/application/`,
      HTTP `test/integration/http/project-write-endpoints.test.ts` (п. 2, 4, 7–9, 11),
      блокировки `test/integration/db/project-write-locks.test.ts`, правка во время удаления
      настоящими use-case'ами на живом PostgreSQL — `test/integration/db/project-roster-races.test.ts`
      (п. 11: правка либо успевает до скрытия, либо получает тот же `404`, что чужой id, и записи
      не оставляет); снапшот сериализатора по ролям
      не нужен — полей разных уровней нет; isolation-тест `projects` — реестровый набор
      `rls-isolation.test.ts` плюс `project-repository.test.ts` (2026-09-06).

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
