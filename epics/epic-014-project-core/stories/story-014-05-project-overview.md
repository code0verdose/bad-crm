---
id: STORY-014-05
epic: EPIC-014
status: backlog
blocked: false
priority: should
estimate: M
---

# STORY-014-05 — Карточка проекта и обзор

**Как** разработчик (P4) **я хочу** открыть проект и сразу увидеть, что это за проект, кто в нём, в
каком он состоянии и куда идти дальше, **чтобы** восстановление контекста занимало секунды, а не
обход четырёх вкладок.

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

- [ ] `packages/client/src/app/routes/_authenticated/projects/$projectId/route.tsx` — layout,
      `beforeLoad: requireProjectMember`, `loader`, `pendingComponent`, `errorComponent`,
      `notFoundComponent`.
- [ ] `packages/client/src/app/routes/_authenticated/projects/$projectId/index.tsx` — обзор,
      `validateSearch: zodValidator(projectOverviewSchema)` (`range`).
- [ ] `packages/client/src/pages/project-overview/page.tsx` + `ui/` — композиция без логики.
- [ ] `packages/client/src/widgets/project-header/project-header.widget.tsx`,
      `widgets/project-overview/project-overview.widget.tsx` +
      `ui/project-team-card.component.tsx`, `ui/project-dates-card.component.tsx`,
      `ui/project-activity-card.component.tsx`, `ui/archived-banner.component.tsx`.
- [ ] `packages/client/src/units/project/service/queries/project-detail.query.ts`,
      `service/hooks/use-project-detail.hook.ts`.
- [ ] `packages/client/src/units/auth/lib/guards/require-project-member.guard.ts`.
- [ ] `packages/server/src/application/project/queries/get-project-detail.query.ts` — проект +
      участники + `permissions` (`canEdit`, `canManageMembers`, `canArchive`) одним запросом.
- [ ] i18n: `packages/client/src/app/i18n/{en,ru}/project.json`.
- [ ] Тесты: `use-project-detail.hook.spec.ts`, компонентные на п. 5, 7, 8,
      `get-project-detail.query.spec.ts` (счётчик SQL, п. 9), e2e `project-overview.spec.ts`
      (п. 2, 3) + axe.

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
