---
id: STORY-014-03
epic: EPIC-014
status: backlog
blocked: false
priority: must
estimate: L
---

# STORY-014-03 — Права на проект и наследование на дочерние ресурсы

**Как** руководитель проекта (P2) **я хочу**, чтобы доступ к проекту автоматически распространялся
на всё, что внутри него, и чтобы закрытый проект не проглядывал ни через один побочный экран,
**чтобы** «приватный» означало приватный, а не «не показан в основном списке».

## Acceptance (Given/When/Then)

1. **Проект — корень цепочки наследования.**
   Given участник с уровнем `EDITOR` на проекте и ни одной записи ACL на дочерних объектах;
   When он открывает доску, задачу, папку файлов, канал или спринт этого проекта;
   Then уровень `EDITOR` наследуется по цепочкам `Task → Board → Project → Organization`,
   `File → FileFolder(path) → Project`, `Channel → Project`, `Sprint → Project` — проверяется
   интеграционным тестом на каждой реальной цепочке.

2. **Точечное закрытие внутри открытого проекта.**
   Given проект `EDITOR` для команды и `ResourceAcl(DOC_PAGE, USER=ivan, NONE)`;
   When Иван открывает этот документ;
   Then **404**; остальные документы проекта остаются доступными — обход останавливается на
   ближайшем узле с записью.

3. **Точечное открытие внутри закрытого проекта.**
   Given проект `PRIVATE`, Иван не участник, но есть `ResourceAcl(FILE, USER=ivan, VIEWER)`;
   When он открывает этот файл по прямой ссылке;
   Then доступ разрешён именно к этому файлу; сам проект и его остальные ресурсы остаются 404.

4. **Единая функция видимости.**
   Given список проектов, автодополнение исполнителей, дашборд, лента активности и (в M4) поиск;
   When любой из них строит выборку;
   Then все вызывают **одну** функцию `visibleProjectIds(actor)` из `domain/project/policies`;
   появление второй реализации ломает архитектурный тест `single-project-visibility-source.spec.ts`.

5. **Негативный сценарий — приватный проект не виден нигде.**
   Given приватный проект и пользователь без доступа;
   When он открывает список проектов, автодополнение проекта, дашборд, ленту активности,
   переключатель проекта и прямую ссылку `/projects/{id}`;
   Then во всех шести местах проект отсутствует, а прямая ссылка даёт **404** (e2e
   `private-project-invisible-everywhere`, митигация `T-PROJ-01`).

6. **Негативный сценарий — 403 вместо 404.**
   Given любой отказ по причине отсутствия объекта, чужого тенанта или `NONE` на цепочке;
   When формируется ответ;
   Then код **404** и `reason = resource_not_found`; подмена на 403 в снапшоте `permission-matrix`
   помечается `⚠ раскрытие существования`.

7. **Негативный сценарий — ошибка резолва.**
   Given БД недоступна при резолве ACL;
   When выполняется проверка;
   Then 503 с `reason = acl_resolution_failed`, а не «разрешено».

8. **Списки не резолвят ACL построчно.**
   Given список из 200 задач нескольких проектов;
   When он строится;
   Then множество доступных проектов вычисляется один раз и подставляется в
   `WHERE project_id = ANY($accessible)` с вычитанием поддеревьев `NONE`; число SQL-запросов не
   зависит от числа строк (тест-счётчик), p95 < 300 мс на 10 000 задач.

9. **Согласованность списка и построчной проверки.**
   Given небольшой набор данных со всеми комбинациями видимости и ACL;
   When сравнивается результат списочного запроса и построчного `can()`;
   Then множества совпадают (интеграционный тест `project-list-consistency.spec.ts`).

10. **Архивный проект — только чтение.**
    Given проект `status = ARCHIVED`;
    When участник с `EDITOR` пытается изменить его или его дочерние объекты;
    Then 409 `project_archived`; чтение при этом требует тех же прав, что и раньше.

11. **Мягко удалённый проект невидим для всех репозиториев.**
    Given `deletedAt IS NOT NULL`;
    When любой репозиторий или отчёт запрашивает данные;
    Then строки не возвращаются: фильтр в Prisma-`$extends`; табличный тест
    `soft-deleted-invisible-in-all-repositories` покрывает все репозитории (`T-PROJ-03`).

## Задачи

- [ ] `packages/server/src/domain/project/access/project-access.policy.ts` — `canReadProject`,
      `canUpdateProject`, `canManageProject`, `canArchiveProject` c `Decision`.
- [ ] `packages/server/src/domain/project/policies/visible-projects.ts` — единственная функция
      видимости (чистая, на вход — принципалы и записи ACL).
- [ ] `packages/server/src/application/project/ports/project-access-reader.port.ts` +
      `infrastructure/persistence/prisma/project-access-reader.adapter.ts` (`projectScope`,
      `accessibleProjectIds`).
- [ ] `packages/server/src/application/access/services/ancestor-chain.service.ts` — регистрация
      цепочек для `BOARD`, `TASK`, `FILE`, `FILE_FOLDER`, `CHANNEL`, `SPRINT` с корнем `PROJECT`.
- [ ] `packages/server/src/infrastructure/persistence/prisma/soft-delete.extension.ts` — глобальный
      фильтр `deletedAt IS NULL`.
- [ ] `packages/client/src/units/project/service/hooks/use-project-access.hook.ts` — чтение
      `permissions` из DTO проекта (сервер вычисляет, клиент не резолвит цепочку).
- [ ] Тесты: `project-access.policy.spec.ts` (таблица истинности §5 + краевые случаи 3, 6, 7, 9),
      `visible-projects.spec.ts`, `single-project-visibility-source.spec.ts`,
      `project-list-consistency.spec.ts`, `soft-deleted-invisible-in-all-repositories.spec.ts`,
      e2e `packages/e2e/tests/project/private-project-invisible-everywhere.spec.ts`.

## Ссылки

- [`permission-model.md` §6 «Наследование ACL», «Списки — отдельная задача»](../../../docs/security/permission-model.md)
- [`permission-model.md` §5, краевые случаи 3, 6, 7, 9; fail-closed таблица](../../../docs/security/permission-model.md)
- [`threat-model.md`, `T-PROJ-01`, `T-PROJ-03`, `T-TENANT-05`](../../../docs/security/threat-model.md)
- [`ux-architecture.md`, «403 vs 404», «Гарды в beforeLoad»](../../../docs/architecture/ux-architecture.md)
- PRD: NFR-2 (p95 < 300 мс), риск `R-15`

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
