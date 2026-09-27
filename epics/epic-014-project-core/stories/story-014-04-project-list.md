---
id: STORY-014-04
epic: EPIC-014
status: in-progress
blocked: false
priority: must
estimate: M
---

# STORY-014-04 — Список проектов с фильтрами

**Как** руководитель проекта (P2) **я хочу** видеть все доступные мне проекты с фильтрами по
статусу, лиду и клиенту и делиться ссылкой на конкретную выборку, **чтобы** коллега открыл ровно тот
же экран, а не «примерно похожий».

> **Сверено с кодом 2026-09-06.** История написана 2026-07-26 (правлена 2026-07-28), до EPIC-011 и
> EPIC-012. Текст ниже оставлен как запись замысла; расхождения с деревом — здесь.
>
> **Пути и имена.**
> - `presentation/http/routes/registry.ts` не существует: реестр — `route-registry.factory.ts`
>   (`createRouteRegistry`) плюс `route-registry.types.ts` в
>   `packages/server/src/presentation/http/`; так же поправлено в
>   [STORY-011-07](../../epic-011-rbac-permissions/stories/story-011-07-policy-layer.md), `:116-117`.
> - Каталога `application/<контекст>/queries/` нет: чтения лежат в `use-cases/` рядом с командами и
>   различаются суффиксом (`application/iam/use-cases/list-employees.query.ts` — прямой образец для
>   `list-projects.query.ts`, вплоть до фильтров в URL и пагинации).
> - Локали клиента — `packages/client/src/shared/i18n/locales/{en,ru}/`, каталога `src/app/i18n/`
>   не существует.
> - Серверные и клиентские тесты — `*.test.ts`; `.spec.ts` носят только сценарии `packages/e2e`
>   (для `project-list.spec.ts` имя в составе остаётся верным, для остальных — нет).
>
> **Чего история не называет, а гейты требуют.**
> - `GET /api/v1/projects` обязан появиться в `docs/api/openapi.yaml`: спека сверяется со стеком
>   Express в обе стороны (`packages/server/test/contract/openapi.test.ts:166`), и маршрут без
>   записи роняет CI так же, как запись без маршрута.
> - Если `project:read` встаёт на маршрут именно этой историей, то **в том же коммите** нужны
>   сентенции `permission.project.*` на EN и RU и удаление строки `project` из `AWAITING_A_ROUTE`
>   (`packages/client/test/i18n/permission-descriptions.test.ts:59`) — гейт двусторонний.
> - Критерии 5 и 6 опираются на снапшот матрицы прав. Сегодня **каждая его ячейка — capability-решение**
>   (`requiredLevel` равен `null` у всех ключей на маршрутах,
>   `packages/server/test/permissions/permission-matrix.test.ts:29-33`); `project:read` в каталоге
>   объявлен с `requiredLevel: 'VIEWER'`, поэтому первый же такой маршрут делает снимок двумерным —
>   его придётся переснять.
>
> **Зависимости, а не работа этой истории.** Критерий 5 требует «единую функцию видимости»
> `visibleProjectIds` — она заводится в
> [STORY-014-03](story-014-03-project-access.md), и правильный её адрес —
> `domain/project/access/visible-projects.policy.ts` (каталога `policies/` в домене нет, а пороги
> покрытия 100/100 стоят на `src/domain/**/access/*.policy.ts`, `packages/server/vitest.config.ts:59`).

## Сделано (2026-09-27) — клиентская половина

Экран `/projects`: маршрут `app/routes/_authenticated/projects/index.tsx` (гард `project:read`,
`forbidden`), страница `pages/projects/page.tsx`, виджет `widgets/project-list/` (фильтры, карточки,
таблица, пустое состояние), юнит `units/project` — схема URL
`model/validation/project-list-search.schema.ts`, хуки `use-project-filters.hook.ts` и
`use-project-list.hook.ts`, запрос `project-list.query.ts`, `fetchProjectList`, ключ
`QueryKeys.Projects.list`; пункт «Проекты» в новой секции навигации «Работа команды»; значок статуса
получил иконку; `shared/ui` — доменно-нейтральный `CardGridSkeleton`; i18n `projects.list.*` и
`nav.*` на EN и RU.

| # | Критерий | Чем доказан |
|---|---|---|
| 1 | состояние в URL, мусор отбрасывается схемой | `project-list-search.schema.test.ts` (whitelist, `z.coerce`, `MAX_PAGE`, нет `client`); `projects-list-screen.test.tsx` — фильтры из адреса уходят в запрос, мусор в адресе даёт дефолты, а не error boundary |
| 2 | debounce 300 мс, отмена по `signal`, `AbortError` не ошибка | `use-project-filters.hook.test.ts` (одна запись после паузы; `reset` гасит недопечатанное); экранный тест — один запрос на слово, `signal` устаревшего запроса `aborted`, состояния ошибки нет |
| 3 | смена фильтра сбрасывает страницу, запись через `replace` | хук-тест по каждому фильтру; экранный тест — `page: 1` в адресе после чипа статуса |
| 4 | `keepPreviousData`, skeleton-карточки на первой загрузке | экранный тест — прежняя карточка на экране, пока висит следующий запрос, скелетона нет; на первой загрузке — `card-grid-skeleton` |
| 7 | пустое состояние по праву `project:create` | экранные тесты с правом и без; отфильтрованная пустота — отдельный текст и «Сбросить фильтры» |
| 11 | переключение вида с клавиатуры, статус не только цветом, axe, EN/RU | стрелка на `radiogroup` меняет вид и держит страницу; значок — слово + иконка; axe на карточках и таблице; реальные словари EN/RU — имена, плюрал счётчика, текст пустого состояния |

**Решения, отличающиеся от текста истории (не молча):**

- Массив в адресной строке — сериализатор роутера (`status=["ACTIVE","ON_HOLD"]` в JSON), не
  `status[]=`; к серверу уходит повтор ключа. Так же сделан справочник сотрудников.
- `validateSearch: schema` без `zodValidator` и `useDebouncedCallback` вместо `useDebouncedValue` —
  так требует `rules/lists-and-filters.mdc` §2 и §6 с 2026-08-30.
- Лоадера `ensureQueryData` нет: данные зависят от search, первую загрузку ведёт `DataState` со
  скелетоном — как у справочника.
- Скелетон — `shared/ui/skeletons/card-grid-skeleton.component.tsx`, а не `project-card.skeleton.tsx`:
  доменный компонент в `shared/ui` запрещён (`rules/design-system.mdc` §9).
- Локали — `shared/i18n/locales/{en,ru}/projects.json` (namespace `projects`), а не `app/i18n/*/project.json`.

**Закрыто 2026-09-27:** кнопка «Новый проект» (`projects.list.create`) — в шапке списка
(`pages/projects/page.tsx`) и в пустом состоянии (`project-list-empty.component.tsx`), обе под
`<Can permission="project:create">` и обе ведут на `/projects/new`; экранные тесты с правом и без
(`test/routes/projects-list-screen.test.tsx`).

**Открыто:**

- e2e `packages/e2e/tests/**/project-list.spec.ts` (п. 1, 3 + axe) — вне зоны этой волны.
- Лиды в фасете без права `user:read` показываются идентификатором — тот же компромисс, что на
  карточке проекта (`ProjectLib.nameOf`).

## Сделано (2026-09-26) — серверная половина

`GET /api/v1/projects` (`project:read`, `aclCheckedIn: 'ListProjectsQuery'`): спека
(`listProjects`, `ProjectListPage`, `ProjectListItem`) и типы клиента, `ListProjectsQuery`,
порт `project-list-query.port.ts` (первый `*-query.port.ts` дерева), адаптер
`project-list-query.adapter.ts`, `visible-projects.policy.ts`, сериализатор, валидатор, ячейка
матрицы прав (семь `allow`: у `guest` ответ пуст по неявной таблице, как `404` на его карточке).

| # | Критерий | Состояние |
|---|---|---|
| 1–4, 7, 11 | URL, debounce, сброс страницы, `keepPreviousData`, пустое состояние, a11y/i18n | **закрыты клиентом 2026-09-27** — см. раздел «Сделано — клиентская половина» ниже; открыто: e2e `project-list.spec.ts` (кнопка «Новый проект» закрыта 2026-09-27) |
| 5 | приватное не видно ни в выдаче, ни в `total`, ни в фасетах | **закрыт на сервере**: одна видимая выборка (`WITH subjects … grants … visible`) под страницей, счётом и фасетами; список ≡ деталь по каждому проекту для пяти субъектов на живом Postgres (`test/integration/db/project-list.test.ts`), фасеты без статуса и лида скрытого проекта — с контролем у владельца |
| 6 | финансы не в списке | **закрыт на сервере**: полей бюджета в схеме нет вовсе, сериализатор — whitelist, HTTP-тест держит тело `toEqual` |
| 8 | `member=me` — активное участие, резолв на сервере | **закрыт**: параметр — слово `me`, не id; `left_at IS NULL`; покинутый проект не в счёт |
| 9 | 1 000 проектов / 10 000 участий, p95 < 300 мс, без N+1 | **закрыт замером** (ниже) |
| 10 | кросс-тенантность | **закрыт**: одинаковые ключи в двух организациях, контроль — субъект соседней видит свой проект; тенант связан в каждом операторе (юнит по `values`, `project-list-query.test.ts`) |

**Замер (2026-09-26)**, Testcontainers `pgvector/pgvector:0.8.5-pg16` — тогдашний пин набора;
`docker-compose.yml` к тому дню уже стоял на `0.8.6-pg16`, пин выровнен вторым замером ниже — на Docker Desktop (macOS),
роль `app_user` под `FORCE RLS`, 1 072 живых проекта организации, свыше 10 000 участий (10 000 массовых плюс фикстура), сортировка по имени
(худшая форма — индекса под порядок нет): `EXPLAIN (ANALYZE, BUFFERS)` — счёт 3,4 мс, страница
4,7 мс, фасеты 5,7 мс; весь запрос через `ListProjectsQuery` — p95 **39,1 мс** на 20 прогонах.
Операторов на список — четыре (узел организации, счёт, страница, фасеты) плюс транзакция, **одни и
те же** на 1 и на 61 видимом проекте. План ходит **не** теми индексами, что называет критерий:
`projects` — `Seq Scan` по строкам организации (счёт видит все видимые проекты, это его природа), при
сортировке по ключу — `uq_projects_org_key` с ранней остановкой; участие вызывающего —
`idx_project_members_org_user`; число участников — `uq_project_members`. `idx_projects_org_status` не
выбирается ни в одной форме.

**Второй замер (2026-09-26) — гранты вызывающего, `pgvector/pgvector:0.8.6-pg16`** (Testcontainers,
тот же образ, что в compose), роль `app_user` под `FORCE RLS`, в `resource_acl` 1 010 210 строк: миллион
шумовых грантов в той же организации (проекты, доски, задачи, страницы; чужие пользователи, роли,
команды), 10 000 в соседней, 200 у самого вызывающего на других типах ресурсов и фикстура. Прежняя
форма CTE `grants` сопоставляла `USER`/`ROLE`/`TEAM` через `OR` и `IN (подзапрос)` на строке ACL:
`subject_id` не попадал в условие индекса, и каждый из трёх операторов списка читал ACL организации
целиком — `Parallel Seq Scan on resource_acl`, ~17 450 буферов, 130–135 мс на оператор. Новая форма
«сначала субъекты» (`WITH subjects` — свой `USER`, живые назначения ролей из `user_roles`, команды из
`team_members`, каждый с `organization_id`; затем join с `resource_acl` по `(organization_id,
subject_id)`, `subject_type` и `resource_type` — фильтром): `Index Scan using idx_resource_acl_subject`,
18 буферов на ACL, 51–60 буферов и 0,16–2,3 мс на весь оператор. Резолвер узла организации
(`acl-reader.adapter.ts`) на том же объёме оставлен как есть: `uq_resource_acl` по `(organization_id,
resource_id)`, 4 буфера, 0,02 мс. Тест плана — `test/integration/db/project-list.test.ts`, блок «the
caller’s grants are found by subject» (40 000 шумовых строк: заметно меньше, но прежняя форма на нём
так же даёт seq scan и валит тест). На объёме критерия 9 (1 072 проекта, 10 000 участий, ~50 000 шумовых
грантов) новая форма: счёт 0,6 мс, страница 2,0 мс, фасеты 1,0 мс; `projects` — `Seq Scan`, участие —
`idx_project_members_org_user`, роли и команды — `idx_user_roles_org_user` и
`idx_team_members_org_user`. p95 через `ListProjectsQuery` не перемерялся — тест держит < 300 мс.

**Счёт и страница — не один снимок.** `withTenant` открывает транзакцию READ COMMITTED, а
`UnitOfWorkPort` уровня изоляции не принимает: запись, закоммиченная между оператором счёта и
оператором страницы, может сдвинуть `total` относительно строк. Скрытого это не показывает — каждый
оператор применяет план видимости сам. `RepeatableRead` для этого чтения потребовал бы расширить порт
(и его двойники), а не одну строку; оставлено открытым, в коде записано честно.

**Расхождения с текстом истории, не правленные молча:**

- `status[]=` в URL критерия 1 — в API `status=ACTIVE&status=ON_HOLD` (повтор ключа, как у
  справочника сотрудников). Клиентской схеме решать, какой вид в адресной строке.
- `client` — **нет**: `Project.clientId` есть в `data-model.md`, в схеме нет; параметр отвергается
  `422` до STORY-014-07.
- По умолчанию архив скрыт (`ACTIVE`, `ON_HOLD`, `CLOSED`) — по STORY-014-07, критерий 1.
- Сортировки: `name`, `key`, `createdAt` в обе стороны, `id` — последним ключом.

## Acceptance (Given/When/Then)

1. **Состояние живёт в URL.**
   Given экран `/projects`;
   When пользователь ищет «bad», выбирает статусы и переключает вид;
   Then URL содержит `?q=bad&status[]=ACTIVE&status[]=ON_HOLD&lead=u1&client=c2&view=grid&sort=name&page=1`;
   схема `projectListSearchSchema` (Zod + `zodValidator` + `z.coerce`) валидирует и отбрасывает
   мусор; перезагрузка и «назад» восстанавливают экран точно.

2. **Debounce и отмена.**
   Given ввод в поиск;
   When пользователь печатает;
   Then в URL и query-key уходит debounced-значение (300 мс, `useDebouncedValue`), предыдущий
   запрос отменяется по `signal`, `AbortError` не показывается как ошибка.

3. **Смена фильтра сбрасывает страницу.**
   Given страница 3;
   When меняется любой фильтр;
   Then `page = 1`, запись в URL через `replace`.

4. **Список не мигает.**
   Given переход между страницами и сменой фильтров;
   When грузятся данные;
   Then `placeholderData: keepPreviousData`; первичная загрузка — skeleton-карточки.

5. **Негативный сценарий — видно только доступное.**
   Given приватные проекты, где пользователь не участник;
   When он открывает список;
   Then их нет ни в выдаче, ни в счётчике `total`, ни в фасетах фильтров; выборка строится через
   единую функцию видимости (`visibleProjectIds`).

6. **Негативный сценарий — финансы не в списке.**
   Given пользователь без `project:view_budget`;
   When он открывает список;
   Then карточки не содержат бюджета и burn ни в ответе API, ни в вёрстке.

7. **Пустое состояние объясняет следующий шаг.**
   Given у пользователя нет ни одного доступного проекта;
   When открыт список;
   Then показано пустое состояние с объяснением и кнопкой «Создать проект», отображаемой только при
   наличии `project:create` (через `<Can>`); при отсутствии права — текст «попросите руководителя
   добавить вас в проект».

8. **Фильтр «мои проекты».**
   Given `?member=me`;
   When список строится;
   Then возвращаются проекты, где пользователь — активный `ProjectMember` (`leftAt IS NULL`);
   значение `me` резолвится на сервере из контекста сессии, а не подставляется клиентом.

9. **Производительность.**
   Given 1 000 проектов и 10 000 участий;
   When запрашивается страница;
   Then p95 < 300 мс, запрос покрыт `idx_projects_org_status` и `idx_project_members_org_user`,
   N+1 отсутствует (тест-счётчик SQL).

10. **Кросс-тенантность.**
    Given организации A и B с одинаковыми ключами проектов;
    When список строится в A;
    Then ни одной строки B; isolation-тест и `permission-matrix` это подтверждают.

11. **a11y и i18n.**
    Given два вида отображения (grid и table);
    When экран проверяется axe и с клавиатуры;
    Then 0 нарушений A/AA, переключение вида доступно с клавиатуры, статусы читаются не только
    цветом (текст + иконка), строки — из i18n EN и RU.

## Задачи

- [x] `application/project/use-cases/list-projects.query.ts` + порт
      `application/project/ports/project-list-query.port.ts` + адаптер
      `infrastructure/persistence/prisma/project-list-query.adapter.ts` (2026-09-26).
- [x] `presentation/http/serializers/project-list-item.serializer.ts`.
- [x] `presentation/http/route-registry.factory.ts` — `project:read`, `aclCheckedIn: 'ListProjectsQuery'`.
- [x] `packages/client/src/app/routes/_authenticated/projects/index.tsx` — (2026-09-27; без
      `zodValidator` и лоадера — см. «Решения» выше)
      `validateSearch: zodValidator(projectListSearchSchema)`, `beforeLoad: requireSession`,
      `loader: ensureQueryData(projectListQueryOptions)`.
- [x] `packages/client/src/units/project/model/validation/project-list-search.schema.ts`.
- [x] `packages/client/src/units/project/service/hooks/use-project-filters.hook.ts` (URL, debounce,
      whitelist, сброс страницы) и `use-project-list.hook.ts` (query + `signal` + keepPreviousData).
- [x] `packages/client/src/units/project/service/queries/project-list.query.ts`;
      `shared/lib/enums/query-keys.constant.ts` — `QueryKeys.Projects.list(params)`.
- [x] `packages/client/src/widgets/project-list/project-list.widget.tsx` +
      `ui/project-filters-bar.component.tsx`, `ui/project-card.component.tsx`,
      `ui/project-grid.component.tsx`, `ui/project-table.component.tsx`,
      `ui/project-list-empty.component.tsx` (пустое состояние; в плане стояло
      «project-empty-state»); скелетон — `shared/ui/skeletons/card-grid-skeleton.component.tsx`
      (доменно-нейтральный вместо планового «project-card.skeleton»).
- [x] i18n: `packages/client/src/shared/i18n/locales/{en,ru}/projects.json` (`projects.list.*`).
- [x] Серверные тесты: `test/unit/domain/project/visible-projects-policy.test.ts`,
      `test/unit/application/list-projects.query.test.ts`,
      `test/unit/persistence/project-list-query.test.ts`,
      `test/integration/http/project-list-endpoints.test.ts`,
      `test/integration/db/project-list.test.ts` (п. 5, 8, 9, 10).
- [x] Клиентские тесты: `use-project-filters.hook.test.ts`, `project-list-search.schema.test.ts`,
      `project-list-rows.util.test.ts`, `test/routes/projects-list-screen.test.tsx` (п. 1–4, 7, 11).
- [ ] e2e `project-list.spec.ts` (п. 1, 3) + axe.

## Ссылки

- [`ux-architecture.md`, «Проекты», «Списки и фильтры», «Пустое состояние объясняет следующий шаг»](../../../docs/architecture/ux-architecture.md)
- [`permission-model.md` §6 «Списки — отдельная задача»](../../../docs/security/permission-model.md)
- [`threat-model.md`, `T-PROJ-01`, `T-PROJ-05`](../../../docs/security/threat-model.md)
- [`data-model.md`, группа 3, индексы](../../../docs/architecture/data-model.md)
- PRD: NFR-2

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
