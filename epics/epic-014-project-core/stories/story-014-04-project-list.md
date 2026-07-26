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
      `shared/lib/enums/query-keys.ts` — `QueryKeys.Projects.list(params)`.
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
