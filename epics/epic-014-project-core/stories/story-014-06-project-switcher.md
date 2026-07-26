---
id: STORY-014-06
epic: EPIC-014
status: backlog
blocked: false
priority: should
estimate: M
---

# STORY-014-06 — Переключатель проекта и контекст в URL

**Как** разработчик (P4) **я хочу** переключать текущий проект из шапки и видеть контекст проекта
прямо в адресе, **чтобы** одна ссылка приводила коллегу в тот же проект и тот же раздел, а не
«в приложение, где надо ещё найти нужное».

## Acceptance (Given/When/Then)

1. **Контекст проекта — в пути, а не в состоянии.**
   Given пользователь работает в проекте;
   When он находится на любом проектном экране;
   Then текущий проект определяется сегментом пути `/projects/$projectId/**`; глобального
   «выбранного проекта» в клиентском сторе, влияющего на данные, **не существует** — иначе ссылка
   перестаёт быть воспроизводимой.

2. **Переключение сохраняет раздел.**
   Given пользователь на `/projects/p1/files?folder=f9`;
   When он выбирает проект `p2` в переключателе;
   Then происходит навигация на `/projects/p2/files`; параметры, зависящие от прежнего проекта
   (`folder`), сбрасываются схемой (`stripSearchParams`), а универсальные (`view`, `sort`)
   сохраняются (`retainSearchParams`).

3. **Быстрый поиск в переключателе.**
   Given открытый переключатель;
   When пользователь печатает;
   Then поиск debounce'ится (300 мс), запрос отменяется по `signal`, показываются только доступные
   проекты; последние 5 посещённых закреплены сверху (`localStorage` — это UI-удобство, не источник
   данных).

4. **Клавиатура.**
   Given фокус в приложении;
   When пользователь нажимает сочетание вызова переключателя;
   Then он открывается, навигация стрелками и Enter работают, фокус возвращается на триггер при
   закрытии, ловушка фокуса корректна (WCAG 2.1 AA).

5. **Негативный сценарий — недоступный проект в URL.**
   Given пользователь вручную вводит `/projects/{чужой-или-несуществующий}/board`;
   When маршрут загружается;
   Then `beforeLoad` даёт **404** до рендера; в переключателе такого проекта нет; из «последних
   посещённых» он вычищается.

6. **Негативный сценарий — потеря доступа во время работы.**
   Given пользователя удалили из приватного проекта, пока у него открыта вкладка;
   When он выполняет следующее действие;
   Then сервер отвечает 404, клиент показывает экран «проект недоступен» с кнопкой «к списку»;
   `permissionsVersion` изменился, `me/permissions` инвалидирован.

7. **Негативный сценарий — архивные проекты.**
   Given архивные проекты;
   When открыт переключатель;
   Then они не показываются по умолчанию, доступны через явный фильтр и помечены визуально.

8. **Заголовок вкладки и хлебные крошки.**
   Given проектный экран;
   When он отрисован;
   Then `document.title` и хлебные крошки содержат ключ и имя проекта (head-менеджмент на маршрут),
   что делает вкладки различимыми при нескольких открытых проектах.

9. **Производительность.**
   Given список доступных проектов;
   When он загружается;
   Then используется отдельный лёгкий эндпоинт (id, key, name, color, status), кешируемый
   `staleTime: 5 min`; переключатель не тянет полные карточки проектов.

10. **a11y и i18n.**
    Given переключатель;
    When он проверяется axe;
    Then 0 нарушений A/AA, `combobox`-семантика с `aria-activedescendant`, объявление результатов в
    live-области, все строки — EN и RU.

## Задачи

- [ ] `packages/client/src/widgets/project-switcher/project-switcher.widget.tsx` +
      `ui/project-switcher-item.component.tsx`, `ui/project-switcher-empty.component.tsx`
      (Mantine `Spotlight`/`Combobox` — API уточнить через MCP `mantine`).
- [ ] `packages/client/src/units/project/service/queries/project-options.query.ts` (лёгкий список),
      `service/hooks/use-project-switcher.hook.ts` (поиск, debounce, недавние, навигация).
- [ ] `packages/client/src/units/project/lib/recent-projects.util.ts` — работа с `localStorage`
      (только UI-порядок, без данных).
- [ ] `packages/client/src/app/routes/_authenticated/projects/$projectId/route.tsx` —
      `retainSearchParams` / `stripSearchParams` при смене `projectId`.
- [ ] `packages/client/src/widgets/app-header/app-header.widget.tsx` — размещение переключателя,
      хлебные крошки, head-менеджмент маршрута.
- [ ] `packages/server/src/application/project/queries/list-project-options.query.ts` +
      запись в `ROUTE_REGISTRY` с `project:read`.
- [ ] i18n: `packages/client/src/app/i18n/{en,ru}/navigation.json`.
- [ ] Тесты: `use-project-switcher.hook.spec.ts` (п. 2, 3, 7), компонентные на клавиатуру (п. 4),
      e2e `project-switcher.spec.ts` (п. 1, 2, 5) + axe.

## Ссылки

- [`ux-architecture.md`, «Глобальный поиск и переключатель проекта», «Принцип 1: состояние экрана
  всегда восстанавливается из URL», «Фокус», «Клавиатурный канбан»](../../../docs/architecture/ux-architecture.md)
- [`permission-model.md` §6 (наследование), §5 fail-closed (404)](../../../docs/security/permission-model.md)
- [`threat-model.md`, `T-PROJ-01`](../../../docs/security/threat-model.md)
- CLAUDE.md, блок 🎨-H (TanStack Router: `retainSearchParams`, `stripSearchParams`, `defaultPreload`)

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
