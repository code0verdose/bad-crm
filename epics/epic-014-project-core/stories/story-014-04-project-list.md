---
id: STORY-014-04
epic: EPIC-014
status: backlog
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

- [ ] `packages/server/src/application/project/queries/list-projects.query.ts` — read-модель,
      фильтры, сортировка, пагинация, `accessibleProjectIds` одним запросом.
- [ ] `packages/server/src/presentation/http/serializers/project-list-item.serializer.ts`.
- [ ] `packages/server/src/presentation/http/routes/registry.ts` — `project:read` с `aclCheckedIn`.
- [ ] `packages/client/src/app/routes/_authenticated/projects/index.tsx` —
      `validateSearch: zodValidator(projectListSearchSchema)`, `beforeLoad: requireSession`,
      `loader: ensureQueryData(projectListQueryOptions)`.
- [ ] `packages/client/src/units/project/model/validation/project-list-search.schema.ts`.
- [ ] `packages/client/src/units/project/service/hooks/use-project-filters.hook.ts` (URL, debounce,
      whitelist, сброс страницы) и `use-project-list.hook.ts` (query + `signal` + keepPreviousData).
- [ ] `packages/client/src/units/project/service/queries/project-list.query.ts`;
      `shared/lib/enums/query-keys.constant.ts` — `QueryKeys.Projects.list(params)`.
- [ ] `packages/client/src/widgets/project-list/project-list.widget.tsx` +
      `ui/project-filters-bar.component.tsx`, `ui/project-card.component.tsx`,
      `ui/project-table.component.tsx`, `ui/project-empty-state.component.tsx`,
      `shared/ui/skeletons/project-card.skeleton.tsx`.
- [ ] i18n: `packages/client/src/app/i18n/{en,ru}/project.json`.
- [ ] Тесты: `use-project-filters.hook.spec.ts` (парсинг, whitelist, сброс страницы),
      `list-projects.query.spec.ts` (п. 5, 9), компонентные на п. 7, e2e `project-list.spec.ts`
      (п. 1, 3) + axe.

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
