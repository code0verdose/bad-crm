---
id: STORY-014-05
epic: EPIC-014
status: in-progress
blocked: false
priority: should
estimate: M
---

# STORY-014-05 — Карточка проекта и обзор

**Как** разработчик (P4) **я хочу** открыть проект и сразу увидеть, что это за проект, кто в нём, в
каком он состоянии и куда идти дальше, **чтобы** восстановление контекста занимало секунды, а не
обход четырёх вкладок.

> **Сверено с кодом 2026-09-06.** История написана 2026-07-26, до EPIC-011 и EPIC-012. Текст ниже
> оставлен как запись замысла; расхождения с деревом — здесь.
>
> **Пути и имена.**
> - Каталога `application/<контекст>/queries/` нет: чтения лежат в `use-cases/` рядом с командами,
>   образец — `application/iam/use-cases/get-team-detail.query.ts`. То есть
>   `get-project-detail.query.ts` ложится в `application/project/use-cases/`.
> - `units/auth/lib/guards/` содержит только сессионные гварды (`require-session.guard.ts`,
>   `redirect-if-authed.guard.ts`, `guard-args.types.ts`). Гвард по правам живёт в другом юните —
>   `packages/client/src/units/iam/service/guards/require-permission.guard.ts`, — и
>   `requireProjectMember` принадлежит туда же либо в `units/project`, но не в `auth`.
> - Локали клиента — `packages/client/src/shared/i18n/locales/{en,ru}/`, каталога `src/app/i18n/` нет.
> - Клиентские и серверные тесты — `*.test.ts`; `.spec.ts` носят только сценарии `packages/e2e`
>   (для `project-overview.spec.ts` имя верно, для остальных из состава — нет).
>
> **Блок `permissions` в DTO — это открытый критерий соседней истории.** Критерии 5 и 9 требуют,
> чтобы решение о видимости кнопок бралось из `permissions: { canEdit, canManageMembers, canArchive }`
> внутри DTO проекта. Такого блока сегодня не отдаёт **ни один** сериализатор: это критерий 12
> [STORY-011-08](../../epic-011-rbac-permissions/stories/story-011-08-effective-permissions.md),
> оставленный открытым с формулировкой «некуда класть, пока нет ресурса ни у одного домена:
> STORY-011-06, EPIC-014». Проект — тот самый первый ресурс, поэтому здесь блок появляется впервые,
> и закрывает он не только эту историю.
>
> **Метрика расхождения из критерия 6.** `ui_server_permission_mismatch_total` не существует;
> это половина критерия 13 той же STORY-011-08, открытая по причине «нужен канал клиентской
> телеметрии». Канал приёма клиентских ошибок при этом есть
> (`POST /api/v1/telemetry/client-error`, EPIC-009) — то есть работа реальная, но она не сводится к
> инкременту в обработчике 403.
>
> **Контракт и права — сделано 2026-09-06, серверная половина.** `GET /api/v1/projects/{projectId}`
> есть в `docs/api/openapi.yaml` (`getProject`, `x-permission: project:read`, схема `ProjectDetail`,
> параметр `ProjectId`), типы клиента перегенерированы; запись в `route-registry.factory.ts` с
> `aclCheckedIn: 'GetProjectDetailQuery'`, контроллер `presentation/http/controllers/project.controller.ts`,
> сериализатор-whitelist `project.serializer.ts`, валидатор `uuid` на `:projectId`
> (`project.validator.ts`); `ResolveAclQuery` и `GetProjectDetailQuery` собраны в
> `container.factory.ts` (`buildProject`). HTTP-набор — `test/integration/http/project-endpoints.test.ts`:
> свой `PUBLIC_ORG` → 200 с полями whitelist'а; несуществующий, чужой, `PRIVATE` без членства и
> удалённый → **одно** `404 project_not_found` с одинаковым телом; без `project:read` → 403
> `permission_not_granted` до единого обращения к портам; владелец без ключа читает `PRIVATE`;
> отказ ридера цепочки → 503 `acl_resolution_failed`, строка не читается.
>
> **Две поправки к тому, что здесь было записано.**
> - Строка `project` из `AWAITING_A_ROUTE` **не удаляется**: гейт
>   (`permission-descriptions.test.ts`, «leaves no key both undescribed and unexcused») требует
>   либо сентенцию, либо строку для **каждого** ключа ресурса, а на маршруте стоит один
>   `project:read` из двенадцати. Удаление строки роняет гейт на одиннадцати ключах записи.
>   Сделано то, чего гейт требует на самом деле: сентенция `permission.project.read` на EN и RU
>   (описывать остальные одиннадцать запрещает второе направление того же гейта) и уточнённая
>   причина в строке `project`. Строка уйдёт с последним `project:*`-маршрутом.
> - Не-uuid в `:projectId` — `422 validation_failed`, а не 404: так отвечает каждый параметрический
>   маршрут этого API (`teamIdParamsSchema`, `roleIdParamsSchema`), и `validated-operations.test.ts`
>   требует объявленного `422` у операции с валидатором. Без валидатора `::uuid` в `scope()` дал бы
>   500 — вот чего маршрут не делает. 422 ничего о существовании не говорит.
>
> **Контракт объявляет `503`** (`ServiceUnavailable`): резолвер отвечает `unavailable` на отказ
> любого из двух ридеров, `authorizeResource` превращает это в `acl_resolution_failed` — код,
> который маршрут действительно возвращает, а спека обязана называть ровно те коды, что достижимы
> (`docs/api/README.md`, «Обязательное для каждой новой операции»).
>
> **Снапшот матрицы** переснят: 14 новых ячеек — по две (`PUBLIC_ORG` / `PRIVATE`, вызывающий не
> участник) на каждую системную роль, — ни одной сдвинутой. Это первое capability ∧ ACL-решение на
> маршруте, а не изменение доступа; подробно — в докстринге `permission-matrix.test.ts` и в
> `permission-model.md`, «Guarded-маршруты сегодня».
>
> **Заметка на следующий шаг (из гейта шага 3).** Писатель строки `projects` — `update`,
> `changeVisibility`, `changeStatus`, `softDelete` — берёт `FOR UPDATE`, а не `scope()` под
> `FOR SHARE`: две транзакции, обе взявшие share-lock на одну строку и обе поднимающие его до
> exclusive, — это deadlock. Для этого чтения неактуально, для CRUD (STORY-014-01) — обязательно.
>
> **Клиентская карточка — сделана 2026-09-26** (раздел «Состояние критериев» ниже); абзац ниже —
> про серверную дельту 2026-09-06.
>
> **Чего в этой дельте нет.** Клиентской карточки (критерии 1–8, 10 целиком), блока `permissions`
> в DTO (критерий 5 — приходит с первым маршрутом записи, когда `canUpdateProject` и соседи
> получат потребителя), финансовых полей и их сокрытия (критерий 9 — полей ещё нет ни в схеме
> ответа, ни в модели чтения, поэтому скрывать нечего; в `ProjectDetail` спеки записано, что они
> сюда не добавляются).

## Acceptance (Given/When/Then)

1. **Layout проекта и его вкладки.**
   Given маршрут `/projects/$projectId`;
   When он открыт;
   Then рендерится layout с шапкой проекта (ключ, название, статус, лид, цвет, сроки) и вкладками
   «Обзор», «Участники», «Файлы», «Настройки»; вкладки будущих доменов (доски, документы, время)
   объявлены, но отключены до соответствующих майлстоунов и не ведут в 404.

2. **Гард уровня маршрута.**
   Given пользователь без доступа к проекту;
   When он открывает прямую ссылку;
   Then `beforeLoad: requireProjectMember` уводит на экран 404 **до** рендера; layout и дочерние
   маршруты не выполняются.

3. **Данные приходят из loader.**
   Given маршрут проекта;
   When он загружается;
   Then `loader` вызывает `queryClient.ensureQueryData(projectDetailQueryOptions(projectId))`,
   компонент читает те же данные `useSuspenseQuery` — второго запроса не выполняется;
   `defaultPreload: 'intent'` префетчит проект при наведении на карточку в списке.

4. **Обзор собирается из фактических данных.**
   Given вкладка «Обзор» (`?range=30d`);
   When она отрисована;
   Then показаны описание, состав команды с ролями и загрузкой, сроки и прогресс по датам,
   последние изменения проекта; блоки будущих доменов (задачи, время, CI) отображаются как
   «появится в следующем релизе», а не как пустые графики.

5. **Права видны заранее.**
   Given участник с уровнем `VIEWER`;
   When он открывает карточку;
   Then кнопки «Редактировать», «Настройки», «Добавить участника» отсутствуют (обёрнуты в `<Can>`);
   решение о видимости берётся из `permissions` в DTO проекта, вычисленных сервером.

6. **Негативный сценарий — расхождение UI и сервера.**
   Given кнопка показана, а сервер отказал;
   When приходит 403;
   Then показывается один тост с человекочитаемой причиной (`DenyReason` → текст), инкрементится
   метрика `ui_server_permission_mismatch_total` — расхождение считается продуктовым дефектом.

7. **Негативный сценарий — архивный проект.**
   Given `status = ARCHIVED`;
   When карточка открыта;
   Then виден баннер «проект в архиве, изменения недоступны», все изменяющие действия отключены с
   объяснением, а не молча (правило «скрывать или показывать disabled»).

8. **Состояния экрана.**
   Given загрузка, ошибка и отсутствие данных;
   When они происходят;
   Then первичная загрузка — skeleton; ошибка загрузки — inline error-state с retry (не тост);
   404 — понятный экран с кнопкой «к списку проектов».

9. **Финансовые блоки скрыты по правам.**
   Given участник без `project:view_budget`;
   When открыт обзор;
   Then блок бюджета отсутствует и в ответе API, и в вёрстке (снапшот-тест сериализатора по ролям).

10. **a11y и i18n.**
    Given карточка проекта;
    When она проверяется axe и с клавиатуры;
    Then 0 нарушений A/AA, вкладки реализованы семантически (`role="tablist"`), заголовки идут по
    иерархии, цвет проекта не является единственным носителем смысла, все строки — EN и RU.

## Задачи

Клиентские строки — по факту кода 2026-09-26 (пути от `packages/client/src/`); где путь разошёлся
с планом, причина в строке.

- [x] `app/routes/_authenticated/projects/$projectId/route.tsx` — layout; `beforeLoad` = право
      `project:read` (`whenDenied: 'not-found'`), затем `ProjectGuards.requireProjectAccess`;
      `loader` (`ensureQueryData`); `pendingComponent`/`errorComponent`/`notFoundComponent`.
- [x] `app/routes/_authenticated/projects/$projectId/index.tsx` — обзор. **Без `validateSearch`
      (`range`)**: его читал бы только блок «последние изменения», а чтения журнала ещё нет
      (STORY-016-03); параметр, который никто не читает, не заводится.
- [x] `pages/project/{layout.tsx,overview-page.tsx}` — многостраничный раздел по
      `rules/naming-and-structure.mdc` п. 3, вместо отдельной страницы обзора из плана.
- [x] `widgets/project-header/project-header.widget.tsx` (баннер архива внутри),
      `widgets/project-overview/project-overview.widget.tsx` + `ui/project-team-card`,
      `ui/project-dates-card`. Баннер, вкладки, «скоро»-блоки, цвет и статус — в `units/project/ui`
      (общие для всех разделов). Отдельной `project-activity-card` нет: активность — «скоро»-блок.
- [x] `units/project/service/queries/{project-detail,project-members}.query.ts`,
      `service/hooks/{use-project,use-project-members}.hook.ts`.
- [x] Гард — `units/project/service/guards/require-project-access.guard.ts`: гарду нужно чтение,
      значит `service/guards` (`rules/frontend-fsd.mdc` п. 9); имя «доступ», а не «участник» —
      `PUBLIC_ORG`-проект читает любой член организации. В `ux-architecture.md` (таблица «Проекты»)
      осталось имя `requireProjectMember`.
- [x] `packages/server/src/application/project/use-cases/get-project-detail.query.ts` — проект
      (шаг 3, `f156ee9`); маршрут, контракт, контроллер, сериализатор, валидатор и сборка в
      контейнере — 2026-09-06. **Без** `permissions` (`canEdit`, `canManageMembers`, `canArchive`)
      и без состава участников: и то и другое — вместе с первым маршрутом записи.
- [ ] Серверная половина критерия 5: блок `permissions` (`canEdit`, `canManageMembers`,
      `canArchive`) в `ProjectDetail` — в контракте его нет.
- [x] i18n: `shared/i18n/locales/{en,ru}/projects.json` (namespace `projects`).
- [x] Тесты клиента: `units/project/**/*.test.ts(x)` (утилиты, гард, хуки),
      `test/routes/project-overview-screen.test.tsx` (всё приложение: п. 1–4, 7, 8, 10 + axe),
      группа `Projects` в `test/api/query-keys.test.ts`.
- [ ] E2E `packages/e2e/tests/**/project-overview.spec.ts` (п. 2, 3) — не написан.

## Состояние критериев (клиент, 2026-09-26)

- **Закрыты:** 1 (будущие разделы — отключённые вкладки с «скоро», ссылок нет), 2 (403/404 →
  экран «не найдено» до layout, состав не запрашивается; без `project:read` запроса нет вовсе),
  3 (один запрос на карточку — доказано счётчиком), 4 (описание, прогресс по датам, команда с
  ролями и загрузкой, «появится в следующем релизе» для активности, задач, времени, CI), 7 (баннер
  архива), 8 (skeleton; inline-ошибка с повтором у карточки и у состава, без тоста; 404-экран),
  10 (tablist, иерархия заголовков, цвет декоративен, EN+RU, axe без нарушений).
- **Открыты:** 5 и 6 — ждут `permissions` в DTO; изменяющих действий на экране пока нет, оборачивать
  в `<Can>` и сопровождать тостом/метрикой нечего. 8 — кнопка «к списку проектов»: списка
  (STORY-014-04) нет, 404-экран ведёт на дашборд. 9 — на клиенте нечего скрывать (финансовых полей
  в контракте нет); снапшот сериализатора — серверная часть.
- **Попутно исправлено:** `app/ui/route-error.component.tsx` — «Повторить» вызывал `reset`
  границы, и при упавшем loader'е кнопка ничего не делала; теперь `router.invalidate()`.
- **По гейту a11y (2026-09-27), к критерию 10.** После успешного «Повторить» фокус падал на
  `<body>`: маршрутный — `RouteAnnouncer` возвращает его на `h1`, когда упавший маршрут
  успокаивается (`widgets/route-announcer/lib/announcement.util.ts`); inline — `ErrorState` переводит
  его на заголовок своей `Section`. Экран «не найдено» — свой `SharedUi.NotFoundState` (`h1` +
  `PAGE_TITLE_ID`) вместо `EmptyState`, у которого был `h2` без id. «EN+RU» критерия 10 до этого был
  доказан только в `cimode`; теперь имена tablist, progressbar, отключённой вкладки и баннер архива
  проверяются на настоящих словарях обоих языков, проценты — через `SharedLib.formatPercent`.

## Ссылки

- [`ux-architecture.md`, «Проекты», «Права в интерфейсе», «Скрывать или показывать disabled»,
  «Состояния экрана»](../../../docs/architecture/ux-architecture.md)
- [`permission-model.md` §7е «Клиент — подсказка UI»](../../../docs/security/permission-model.md)
- [`data-model.md`, группа 3](../../../docs/architecture/data-model.md)
- [`threat-model.md`, `T-PROJ-05`](../../../docs/security/threat-model.md)

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
