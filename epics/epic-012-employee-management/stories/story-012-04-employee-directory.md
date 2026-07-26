---
id: STORY-012-04
epic: EPIC-012
status: backlog
blocked: false
priority: should
estimate: M
---

# STORY-012-04 — Справочник сотрудников с фильтрами

**Как** тимлид (P3) **я хочу** быстро находить людей по роли, команде, отделу и статусу и делиться
ссылкой на нужную выборку, **чтобы** не спрашивать «а кто у нас на бэкенде» в чате и попадать в тот
же список, что и коллега.

## Acceptance (Given/When/Then)

1. **Состояние фильтров живёт в URL.**
   Given экран `/admin/members`;
   When пользователь ищет «ив», выбирает роль `developer`, статус `ACTIVE` и команду;
   Then URL содержит `?q=ив&role[]=developer&status[]=ACTIVE&team[]=t1&sort=name&page=1`;
   схема `memberListSearchSchema` (Zod + `zodValidator`) валидирует, приводит (`z.coerce`) и
   отбрасывает мусор; перезагрузка и «назад» восстанавливают ровно тот же экран.

2. **Debounce и отмена запроса.**
   Given пользователь печатает в поиске;
   When между нажатиями меньше 300 мс;
   Then в URL и в query-key уходит уже debounced-значение (`useDebouncedValue`), предыдущий запрос
   отменяется через `signal`, `AbortError` не показывается как ошибка.

3. **Смена фильтра сбрасывает страницу.**
   Given пользователь на странице 4;
   When он меняет любой фильтр;
   Then `page` сбрасывается в 1, запись в URL идёт через `replace` (история не засоряется).

4. **Список не мигает.**
   Given переход между страницами;
   When грузится следующая порция;
   Then применяется `placeholderData: keepPreviousData`; первичная загрузка — skeleton, а не спиннер.

5. **Негативный сценарий — видно только своё.**
   Given пользователь без `employee:view_personal_data`;
   When он открывает справочник;
   Then строки содержат только имя, аватар, должность, отдел, команды и статус; колонок с датами
   найма, типом занятости и себестоимостью нет ни в ответе API, ни в экспорте.

6. **Негативный сценарий — нет права на раздел.**
   Given пользователь без `user:read`;
   When он открывает `/admin/members`;
   Then гард `beforeLoad` уводит на экран 403 до рендера; пункт меню не отображается.

7. **Негативный сценарий — деактивированные скрыты по умолчанию.**
   Given в организации есть `SUSPENDED`-сотрудники;
   When фильтр статуса не задан;
   Then в выдаче только `ACTIVE` и `INVITED`; деактивированные показываются только при явном
   `status[]=SUSPENDED` и визуально помечены.

8. **Оргструктура.**
   Given включён вид «оргструктура»;
   When он отрисован;
   Then дерево строится по `EmployeeProfile.managerId` за один запрос (без N+1), проверяется тестом
   на число SQL-запросов; сотрудник без руководителя показан в корне.

9. **Производительность.**
   Given 5 000 сотрудников в организации;
   When запрашивается страница списка;
   Then p95 серверной обработки < 300 мс, запрос покрыт индексом
   `idx_users_org_status (organization_id, status)`, N+1 отсутствует (NFR-2).

10. **Кросс-тенантность.**
    Given два арендатора с похожими именами;
    When выполняется поиск в организации A;
    Then в выдаче нет ни одной строки организации B; isolation-тест и `permission-matrix` это
    подтверждают.

## Задачи

- [ ] `packages/server/src/application/iam/queries/list-employees.query.ts` — плоская read-модель,
      keyset/offset-пагинация, фильтры, сортировка; `get-org-chart.query.ts` (рекурсивный CTE).
- [ ] `packages/server/src/presentation/http/serializers/employee-list-item.serializer.ts` — уровни
      по правам.
- [ ] `packages/server/src/presentation/http/routes/registry.ts` — `employee:read`,
      `employee:view_org_chart`.
- [ ] `packages/client/src/app/routes/_authenticated/admin/members/index.tsx` — `validateSearch`,
      `beforeLoad: requirePermission('user:read')`, loader через `ensureQueryData`.
- [ ] `packages/client/src/units/employee/model/validation/member-list-search.schema.ts`.
- [ ] `packages/client/src/units/employee/service/hooks/use-employee-filters.hook.ts` (URL + debounce
      + парсинг) и `use-employee-list.hook.ts` (композиция с query и `signal`).
- [ ] `packages/client/src/widgets/employee-directory/employee-directory.widget.tsx` +
      `ui/employee-filters-bar.component.tsx`, `ui/employee-table.component.tsx`,
      `ui/org-chart.component.tsx`, `ui/employee-empty-state.component.tsx`.
- [ ] i18n: `packages/client/src/app/i18n/{en,ru}/members.json`.
- [ ] Тесты: `use-employee-filters.hook.spec.ts` (парсинг/whitelist/сброс страницы),
      `list-employees.query.spec.ts` (счётчик SQL, п. 8, 9), снапшот сериализатора (п. 5),
      e2e `members-directory.spec.ts` (п. 1, 3, 7) + axe.

## Ссылки

- [`ux-architecture.md`, `/admin/members`, «Списки и фильтры», «Таблицы»](../../../docs/architecture/ux-architecture.md)
- [`data-model.md`, группа 1, индексы `idx_users_org_status`](../../../docs/architecture/data-model.md)
- [`permission-model.md` §3.2, §3.19 (список — это `read`, а не отдельное право)](../../../docs/security/permission-model.md)
- PRD: NFR-2 (p95 < 300 мс), NFR-12

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
