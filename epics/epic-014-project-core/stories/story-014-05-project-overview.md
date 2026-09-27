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
> **Блок `permissions` в DTO был открытым критерием соседней истории (закрыт 2026-09-27).** Критерии 5 и 9 требуют,
> чтобы решение о видимости кнопок бралось из `permissions: { canEdit, canManageMembers, canArchive }`
> внутри DTO проекта. Это же критерий 12
> [STORY-011-08](../../epic-011-rbac-permissions/stories/story-011-08-effective-permissions.md),
> оставленный открытым с формулировкой «некуда класть, пока нет ресурса ни у одного домена:
> STORY-011-06, EPIC-014». Проект — тот самый первый ресурс, поэтому здесь блок появляется впервые,
> и закрывает он не только эту историю. **Серверная половина отгружена 2026-09-27** — раздел
> «Блок `permissions`: серверная половина» ниже.
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
> получат потребителя; *отгружен 2026-09-27, см. ниже*), финансовых полей и их сокрытия (критерий 9 — полей ещё нет ни в схеме
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
- [x] Серверная половина критерия 5 (2026-09-27): блок `permissions` в `ProjectDetail` —
      `domain/project/access/project-permissions.policy.ts` (`decideProjectPermissions`),
      `application/project/project-card.util.ts` (`ProjectCard`, мемоизированные `projectReadFacts`),
      сериализатор-whitelist, схема `ProjectPermissions` в контракте, типы клиента перегенерированы.
- [x] Пятый флаг `canChangeVisibility` (2026-09-27) — дополнение в разделе «Блок `permissions`:
      серверная половина» ниже.
- [x] i18n: `shared/i18n/locales/{en,ru}/projects.json` (namespace `projects`).
- [x] Тесты клиента: `units/project/**/*.test.ts(x)` (утилиты, гард, хуки),
      `test/routes/project-overview-screen.test.tsx` (всё приложение: п. 1–4, 7, 8, 10 + axe),
      группа `Projects` в `test/api/query-keys.test.ts`.
- [x] E2E `packages/e2e/tests/projects/project-overview.spec.ts` (2026-09-27; п. 2, 5, 8, 10):
      404-параметр стороннего приватного проекта неотличим от несуществующего id, тот же способ
      выхода («к списку проектов»); danger zone `/projects/$projectId/settings` рисуется по блоку
      `permissions`, а не по роли — `MEMBER` (`EDITOR` на цепочке, одноразовый коллега) не видит
      «Архивировать»/«Удалить», лид проекта (`admin`, `MANAGER`) видит оба и оба не задизейблены;
      axe на заполненной карточке. Доказательство красного — убран
      `ProjectService.ProjectGuards.requireProjectAccess` в
      `app/routes/_authenticated/projects/$projectId/route.tsx`: оба сценария падают («Back to
      projects» не находится, «Nothing here» не находится), возвращено обратно.

## Состояние критериев (клиент, 2026-09-26)

- **Закрыты:** 1 (будущие разделы — отключённые вкладки с «скоро», ссылок нет), 2 (403/404 →
  экран «не найдено» до layout, состав не запрашивается; без `project:read` запроса нет вовсе),
  3 (один запрос на карточку — доказано счётчиком), 4 (описание, прогресс по датам, команда с
  ролями и загрузкой, «появится в следующем релизе» для активности, задач, времени, CI), 7 (баннер
  архива), 8 (skeleton; inline-ошибка с повтором у карточки и у состава, без тоста; 404-экран),
  10 (tablist, иерархия заголовков, цвет декоративен, EN+RU, axe без нарушений).
- **Открыты:** ~~5 и 6 — ждали `permissions` в DTO~~ — снято 2026-09-27: критерий 5 закрыт на
  клиенте, 6 — наполовину, открыта метрика (раздел «Блок `permissions`: клиентская половина» ниже).
  ~~8 — кнопка «к списку проектов»~~ — закрыто 2026-09-27: у `/projects/$projectId` свой
  `notFoundComponent` — `app/ui/project-not-found.component.tsx`, тот же `SharedUi.NotFoundState`
  (заголовок и текст неотличимы от любого 404, 403 и 404 по-прежнему одинаковы), действие —
  `projects.notFound.action`, ссылка на `/projects`. Остальные маршруты не тронуты: дефолт роутера
  и splat `_authenticated/$` ведут на `/dashboard`. Тесты — `test/routes/project-overview-screen.test.tsx`
  («leads from a refused project (404|403) to the list of projects», с контролем «общей ссылки
  рядом нет») и прежний `test/routes/navigation.test.tsx` («offers a way back from the not-found
  screen» → `/dashboard`). Не покрыт адрес **под** читаемым проектом, которого нет
  (`/projects/<id>/nope`): его ловит splat `_authenticated/$`, а не маршрут проекта, и он ведёт на
  сводку; своего splat у проекта нет. 9 — на клиенте нечего скрывать (финансовых полей
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

## Блок `permissions`: серверная половина критерия 5 (2026-09-27)

**Форма в контракте** (`docs/api/openapi.yaml`, схема `ProjectPermissions`, обязательное поле
`permissions` у `ProjectDetail`): `{ canEdit, canManageMembers, canChangeVisibility, canArchive,
canDelete }`, все пять — `boolean`, все обязательны, `additionalProperties: false`.

**Набор флагов — объединение документов, а не выбор.** Эта история называет `canEdit`,
`canManageMembers`, `canArchive`; критерий 12 STORY-011-08 и `ux-architecture.md` — ещё `canDelete`;
STORY-014-01 — `canChangeVisibility` (добавлен 2026-09-27, см. ниже). Флаг заводится только там, где
есть команда, решение которой он обещает: у `project:manage_settings` маршрута нет — его в блоке нет.

| Флаг | Функция policy | Команда, которая её же вызывает |
|---|---|---|
| `canEdit` | `canUpdateProject` (`project:update`, `EDITOR`) | `UpdateProjectUseCase` (без смены лида) |
| `canManageMembers` | `canManageProjectMembers` (`project:manage_members`, `MANAGER`) | `Add/Update/RemoveProjectMemberUseCase`, смена `leadId` в `UpdateProjectUseCase` |
| `canChangeVisibility` | `canManageProjectVisibility` (`project:manage_visibility`, `MANAGER`) | `ChangeProjectVisibilityUseCase` |
| `canArchive` | `canArchiveProject` (`project:archive`, `MANAGER`) | `ArchiveProjectUseCase` |
| `canDelete` | `canDeleteProject` (`project:delete`, `MANAGER`) | `DeleteProjectUseCase` |

**Второй точки вычисления нет (R-15).** `decideProjectPermissions` вызывает те же функции
над теми же фактами (`scope()` + резолвер цепочки), на которых `GetProjectDetailQuery` только что
решил `project:read`; факты мемоизированы (`projectReadFacts`), поэтому блок не добавляет ни одного
оператора — след портов тот же `scope → acl → detail`. Архивный проект флаги не гасят: команды на
нём сегодня не отказывают (правило «только чтение» — STORY-014-07), и блок обязан совпадать с
командами, а не с замыслом.

**`POST /projects` отдаёт тот же блок** — ответ описан как «проект, каким его прочтёт
`GET /projects/{projectId}`», и схема у них одна. `CreateProjectUseCase` получил резолвер и решает
флаги над только что записанным `LEAD`-местом создателя. Отказ резолвера здесь не 503, а
`false` во всех флагах (fail-closed): строка уже записана, и ронять создание из-за подсказки нельзя.

**Список (`GET /projects`) блока не получает**: STORY-014-04 его не требует, а в элементе списка
кнопок изменения нет.

**Тесты.** `test/unit/application/project-card-permissions.test.ts` — таблица «7 системных ролей +
admin с DENY на `project:archive`» × «зритель `PUBLIC_ORG`, `OBSERVER`, `REVIEWER`, `MEMBER`, `LEAD`,
`PRIVATE` без места»: эталон справа — **сама команда** на свежем сторе с тем же посевом, а не
выписанная руками таблица; контроль, что каждый флаг принимает оба значения и что `canEdit` ≠
`canArchive` хотя бы в одной строке; контроль «ни одного лишнего чтения». HTTP-форма —
`project-endpoints.test.ts` (зритель — все `false`; `MEMBER` и `LEAD` — два разных блока, след тот
же) и `project-write-endpoints.test.ts` (`201` с блоком). Сериализатор — `project-serializer.test.ts`
(whitelist внутри блока; три фикстуры, различающие каждую пару флагов).

**Доказательство красного** (внесён дефект — точное падение — откат):
- `canArchive` вычислен `canUpdateProject` → 7 падений таблицы, например
  `admin · MEMBER: every flag is what its command decides` с `-"canArchive": false / +"canArchive": true`;
- мемоизация фактов снята → `expected [ 'scope', 'scope', 'scope', …(2) ] to have a length of 1 but got 5`;
- `CreateProjectUseCase` решает флаги на `NO_PROJECT_YET` →
  `expected { canEdit: false, …(3) } to deeply equal { canEdit: true, …(3) }`;
- сериализатор копирует `canArchive` из `canEdit` → падает `carries each flag as decided, not a copy
  of its neighbour` (первая версия теста с «зеркальной» фикстурой этот дефект **не** ловила —
  зеркало сохраняет равные пары; заменена).

**Открыто:** критерий 6 — половина с метрикой (см. ниже).

**Дополнение 2026-09-27 — `canChangeVisibility`.** Клиентская половина нарисовала кнопку смены
видимости по одной capability `project:manage_visibility`, без уровня `MANAGER`, потому что флага не
было; это расхождение UI и сервера по построению, которое запрещает `permission-model.md` §7 (е).
Флаг — решение `canManageProjectVisibility`, той же функции, что ассертит
`ChangeProjectVisibilityUseCase`; подтверждения `X-Confirm-Dangerous` он не отвечает (его команда
спрашивает **после** решения). Эталон в таблице — сама команда с `confirmedDangerous: true`, чтобы
`428` не подменил ответ о доступе. Доказательство красного — флаг вычислен не той функцией:
- `canArchiveProject` → 1 падение, `admin with DENY on project:archive · LEAD` (`-false / +true`);
- `canUpdateProject` → 5 падений, например `admin · MEMBER` (`-true / +false`);
- `canManageProjectMembers` → 1 падение, `lead · LEAD`; `canDeleteProject` → 1, `manager · LEAD`.

Сериализатор: две фикстуры дают каждому флагу двухбитную подпись, а различных подписей всего
четыре, поэтому пять флагов потребовали третьей; копия `canChangeVisibility` из любого соседа и
`canArchive` из `canChangeVisibility` роняют `carries each flag as decided`. Клиент читает флаг с
того же дня (кнопка видимости и вкладка «Настройки», см. ниже; STORY-014-01).

## Блок `permissions`: клиентская половина критериев 5 и 6 (2026-09-27)

- **Критерий 5 — закрыт на клиенте.** Все изменяющие элементы карточки читают блок через
  `units/project/service/hooks/use-project-controls.hook.ts` и ничего не выводят из роли: форма
  правки — `canEdit`, архив — `canArchive`, удаление — `canDelete`, добавление/смена роли/исключение
  участника и смена лида — `canManageMembers`, смена видимости — `canChangeVisibility`; вкладка
  «Настройки» не рисуется, когда блок не открывает ни одной её команды
  (`pages/project/hooks/use-project-section.hook.ts`) — capability читателя в условии нет с
  2026-09-27 (временная половина по `project:manage_visibility` снята вместе с исключением ниже). Отдельной кнопки
  «Редактировать» в шапке нет: правка — это вкладка «Настройки». Вкладки «Участники» и «Настройки»
  стали маршрутами; выбор вкладки — навигация.
- ~~**Исключение — видимость:** флага в контракте нет, кнопка рисуется по capability
  `project:manage_visibility` (`useCan().holds`).~~ Снято 2026-09-27: кнопка рисуется по
  `canChangeVisibility`; держатель capability, которому блок отказал, не видит ни кнопки, ни (если
  больше ничего не открыто) вкладки — `project-settings-screen.test.tsx`, «changing the visibility».
- **Критерий 7 распространён на действия:** на архивном проекте элементы остаются на экране и в
  табуляции (`aria-disabled`, поля `readOnly`, отправка отбрасывается в обработчике), пояснение
  `ArchivedNote` стоит у каждой секции (`aria-describedby`); удаление доступно (уточнено 2026-09-27).
- **Критерий 6 — половина.** Отказ показанной кнопки даёт **один** сигнал с человекочитаемой
  причиной по `reason` (`units/project/lib/utils/project-refusal.util.ts`: `permission_not_granted`,
  `insufficient_acl_level`, `self_assignment_forbidden`): тост для действий из строки состава,
  `role="alert"` внутри `aria-modal`-диалога для архива/удаления/видимости, поле формы для лида.
  **Метрика `ui_server_permission_mismatch_total` не сделана** — нужен канал клиентской телеметрии.
- **Тесты:** `packages/client/test/routes/project-settings-screen.test.tsx` — каждый флаг в обоих
  значениях, «capability без флага ничего не рисует», формы (валидация, серверная ошибка поля, успех),
  оптимистичный откат роли и исключения на прежнее место (рефетч удержан, иначе откат не доказать),
  диалог (фокус внутри, в обе стороны, по кругу, `Esc`, возврат на триггер; реестр
  `test/architecture/modal-focus-coverage.test.ts`), реальные словари en/ru для имён; юнит-тесты
  `units/project/**/*.test.ts`; `test/api/optimistic.test.ts` (адресация по `idKey`).

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
