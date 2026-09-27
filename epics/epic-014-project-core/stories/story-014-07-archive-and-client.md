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

> **Сверено с кодом 2026-09-06.** История написана 2026-07-26, до EPIC-011, EPIC-012 и журнала
> действий. Текст ниже оставлен как запись замысла; расхождения с деревом — здесь.
>
> **`Client.slug` — расхождение с каноном, и правится история.** История требовала справочник
> `Client(name, slug, notes)` и индекс `uq_clients_org_slug`, а
> [`data-model.md:2668`](../../../docs/architecture/data-model.md) описывает `Client` **без поля
> `slug`**: `name`, `legalName`, `taxId`, `country`, `defaultCurrency`,
> `status LEAD|ACTIVE|PAUSED|CHURNED`, `ownerId` (аккаунт-менеджер), `website`, `notes`, `deletedAt?`.
> Порядок источников истины в этом репозитории однозначен — имена сущностей, таблиц и полей задаёт
> модель данных, — поэтому критерии 6 и 7 и состав приведены к ней этой правкой, а `slug` из них
> убран. Если продукту он действительно нужен (человекочитаемый адрес карточки клиента, импорт по
> внешнему ключу), это отдельное предложение с обоснованием и правкой `data-model.md`, а не
> молчаливая колонка в миграции. Уникальность в M2 держится на имени в пределах организации.
>
> **Кода ошибки для клиента сегодня выразить нечем.** `client` **отсутствует** в `ERROR_RESOURCES`
> (`packages/shared/src/errors/error-code.enums.ts:17-45`), а тройка `*_not_found` / `*_forbidden` /
> `*_already_exists` генерируется именно из этого списка. Значит обещанные критериями 8 и 9
> `403` и **404 для чужого `clientId`** требуют явной работы — добавить `client` в `ERROR_RESOURCES`
> с переводами обеих сторон, — и это отдельная строка состава, а не следствие. `project` в списке
> уже есть (`:30`), `project_not_found` доступен без правок.
>
> **Пути и имена.**
> - `presentation/http/routes/registry.ts` не существует: реестр — `route-registry.factory.ts`
>   (`createRouteRegistry`) плюс `route-registry.types.ts` в
>   `packages/server/src/presentation/http/`; так же поправлено в
>   [STORY-011-07](../../epic-011-rbac-permissions/stories/story-011-07-policy-layer.md), `:116-117`.
> - Локали клиента — `packages/client/src/shared/i18n/locales/{en,ru}/`, каталога `src/app/i18n/` нет.
> - Серверные тесты — `*.test.ts` в `packages/server/test/**`; `.spec.ts` носят только сценарии
>   `packages/e2e`.
>
> **Утверждения, которых код не подтверждает.**
> - `AuditLog`: каталог действий закрытый (`packages/shared/src/audit/audit-action.enums.ts`), и
>   `project.*` в нём нет ни одного. `project.archived` из критерия 1, событие восстановления из
>   критерия 3 и запись обнуления `clientId` из критерия 10 — расширение закрытого каталога с
>   докстрингом на каждое действие, а не деталь use-case.
> - Кода `project_archived` в каталоге кодов нет (критерий 2). `permission_not_granted` из
>   критериев 4 и 8 — это `DenyReason`
>   (`packages/shared/src/permissions/deny-reason.enums.ts:22`), он существует;
>   `resource_not_found` из критерия 9 — тоже `DenyReason` (`:28`), но **ответ** наружу несёт код
>   ресурса, которого для клиента пока нет (см. абзац выше).
> - `project:archive` в каталоге прав объявлен с `requiredLevel: 'MANAGER'` и `dangerous: false`;
>   `project:delete` и `project:manage_visibility` — `dangerous: true`. Критерий 1 требует
>   подтверждения для архивации: подтверждение здесь продуктовое, из `dangerous` оно не следует.
>
> **Чего история не называет, а гейты требуют.**
> - Гейт описаний прав двусторонний и падает **дважды** на этой истории:
>   `packages/client/test/i18n/permission-descriptions.test.ts` требует сентенцию для каждого
>   ключа, объявленного маршрутом, и роняет сборку на строке `AWAITING_A_ROUTE`, переставшей быть
>   правдой. Там стоят и `project` (`:59`), и `client` (`:84`, «project leadership is M7»). Маршруты
>   `project:archive` и `client:read/create/update/delete` обязаны прийти **в том же коммите** с
>   `permission.project.*` и `permission.client.*` на EN и RU и с удалением **обеих** строк.
> - `docs/api/openapi.yaml` сверяется со стеком Express в обе стороны
>   (`packages/server/test/contract/openapi.test.ts:166`): шесть новых маршрутов без записей в
>   спеке роняют CI.
> - Таблица `clients` обязана получить строку в
>   `infrastructure/persistence/prisma/tenant-tables.constant.ts` и фабрику строки в
>   `test/integration/db/row-factories.util.ts` (`satisfies Record<TenantTableName, TenantRowFactory>`,
>   `:414`) — без них код **не компилируется**.

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
   Given справочник клиентов-заглушка (`Client`: `name`, `status`, `notes` — поля из
   `data-model.md:2668`; `slug` в модели нет, правка 2026-09-06) и право `client:read`;
   When в настройках проекта выбирается клиент;
   Then заполняется `Project.clientId`; на карточке проекта отображается имя клиента; запрос
   покрыт `idx_projects_org_client`.

7. **Границы задела под M9.**
   Given `Client` в M2;
   When проверяется скоуп;
   Then справочник содержит **только** идентификацию (имя, статус, заметка — правка 2026-09-06:
   было «имя, slug, заметка», `slug` в модели данных отсутствует) — ни контрактов, ни
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
      (`name`, `status`, `notes`, `deleted_at`; правка 2026-09-06 — поля по
      `data-model.md:2668`, `slug` и `uq_clients_org_slug` убраны, уникальность — по имени
      в пределах организации среди живых строк), FK
      `projects.client_id → clients.id ON DELETE RESTRICT`, RLS `ENABLE` + `FORCE` + политики.
- [ ] `packages/server/src/application/client/use-cases/{create,update,delete}-client.use-case.ts`,
      `queries/list-clients.query.ts` (минимальный справочник).
- [ ] `packages/server/src/presentation/http/routes/registry.ts` — `project:archive`,
      `client:read/create/update/delete`.
- [ ] `packages/client/src/widgets/project-settings/project-settings.widget.tsx` +
      `ui/archive-project-dialog.component.tsx`, `ui/client-select.component.tsx` (под `<Can>`).
- [ ] `packages/client/src/units/client/{model,service,ui}` — минимальный юнит справочника.
- [ ] `packages/shared/src/errors/error-code.enums.ts` — добавить `client` в `ERROR_RESOURCES`
      (сегодня его там нет, поэтому 403 и 404 из критериев 8 и 9 выразить нечем) + переводы
      кодов на EN и RU; гейт — `packages/client/test/i18n/error-codes-parity.test.ts`.
- [ ] `packages/shared/src/audit/audit-action.enums.ts` — `project.archived` и действия критериев
      3 и 10; каталог закрытый, каждое действие с докстрингом.
- [ ] `packages/client/src/shared/i18n/locales/{en,ru}/` — сентенции `permission.project.*` и
      `permission.client.*` + удаление строк `project` и `client` из `AWAITING_A_ROUTE`
      (`packages/client/test/i18n/permission-descriptions.test.ts:59,84`).
- [ ] `docs/api/openapi.yaml` — шесть новых операций; сверка со стеком Express двусторонняя
      (`packages/server/test/contract/openapi.test.ts:166`).
- [ ] `packages/server/src/infrastructure/persistence/prisma/tenant-tables.constant.ts` +
      `packages/server/test/integration/db/row-factories.util.ts` — строка и фабрика для `clients`;
      без них код не компилируется.
- [ ] i18n: `packages/client/src/app/i18n/{en,ru}/project.json`, `client.json`.
- [ ] Тесты: `archive-project.use-case.spec.ts`, табличный `archived-project-blocks-writes.spec.ts`
      (п. 2), интеграционные п. 6, 8–10, isolation-тест `clients`.

## Открытый продуктовый вопрос: удаление архивного проекта (2026-09-27)

Клиентские экраны проекта отгружены раньше этой истории, и на архивном проекте они уже ведут себя
по критерию 2 со стороны UI: форма правки и кнопки видимости и архива остаются на экране
недоступными (`aria-disabled`, без обработчика; `SharedLib.lockedControlProps`), строки состава
заблокированы, форма добавления участника не рисуется, а пояснение `ArchivedNote`
(`units/project/ui/archived-note.component.tsx`) стоит у каждой секции; в шапке карточки —
баннер архива (`units/project/ui/archived-banner.component.tsx`). **Удаление при этом
доступно** — и баннер ему противоречит:

- EN — `projects.archived.description`: «Nothing in it can be changed while it stays in the
  archive.»
- RU — `projects.archived.description`: «Пока проект в архиве, изменить в нём ничего нельзя.»

Та же фраза стоит последствием в диалоге архивации (`projects.archive.consequence.readOnly`, RU —
«Пока проект в архиве, в нём ничего нельзя изменить.»). Решить продукту, до реализации критерия 2
на сервере:

- удаление архивного проекта разрешено — тогда текст баннера и последствия уточняется
  («изменить нельзя, удалить можно»), а табличный тест критерия 2 явно исключает `DELETE`;
- удаление запрещено до восстановления — тогда кнопка удаления блокируется тем же способом
  (`lockedControlProps`), а `DELETE /projects/{projectId}` попадает в табличный тест
  `project_archived`.

Текст локалей до решения не меняется.

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
