---
id: STORY-011-09
epic: EPIC-011
status: backlog
blocked: false
priority: must
estimate: M
---

# STORY-011-09 — permission-matrix snapshot test и CI-гейт каталога

**Как** ревьюер кода **я хочу** видеть в диффе PR каждое изменение фактических прав по всем парам
(системная роль × endpoint), **чтобы** случайное расширение доступа или подмена 404 на 403 не
проезжали через ревью незамеченными, а «намеренно» подтверждалось явным обновлением снапшота.

## Acceptance (Given/When/Then)

1. **Снапшот строится на реальном HTTP-стеке.**
   Given поднятое приложение с тестовой БД (Testcontainers) и по одному пользователю на каждую из
   7 системных ролей;
   When гоняется `permission-matrix.spec.ts`;
   Then каждый endpoint из `ROUTE_REGISTRY` вызывается через supertest от имени каждой роли, и
   фактический ответ сравнивается с `test/permissions/__snapshots__/permission-matrix.json`.

2. **Ячейка хранит причину, а не голый deny.**
   Given `viewer` вызывает `PATCH /api/v1/tasks/{taskId}`;
   When пишется снапшот;
   Then значение — `"deny:permission_not_granted"`; для `guest` без ACL — `"deny:resource_not_found"`.

3. **Негативный сценарий — расширение прав видно в диффе.**
   Given разработчик добавил `task:update` роли `viewer`;
   When гоняется тест;
   Then он падает, а кастомный сериализатор печатает строку с пометкой `⚠ расширение прав`:
   `+ viewer PATCH /api/v1/tasks/{taskId} deny:permission_not_granted → allow`.

4. **Негативный сценарий — раскрытие существования объекта.**
   Given отказ для `guest` изменился с `deny:resource_not_found` на `deny:permission_not_granted`;
   When гоняется тест;
   Then падение помечается `⚠ раскрытие существования` — это регресс безопасности, а не косметика.

5. **Обновление снапшота требует отдельного ревью.**
   Given PR, изменяющий `test/permissions/__snapshots__/**`;
   When открывается PR;
   Then CODEOWNERS требует ревью ответственного за модель прав, а шаблон PR требует обоснования при
   наличии строк `⚠ расширение прав`.

6. **Каталог и матрица кода не расходятся с документом.**
   Given `catalogSize` в снапшоте и `SYSTEM_ROLE_PERMISSIONS`;
   When изменён каталог без обновления §3/§4 `permission-model.md` (или наоборот);
   Then агент `permission-matrix-auditor` даёт `FAIL`; проверки агента: мёртвое право, маршрут с
   `requiredLevel = null` при работе с объектом, `*_any`/`*_all`/`override`/`export`/`impersonate`
   без `dangerous`, диффы без обоснования, вторая точка вычисления прав.

7. **Каждый ключ каталога используется.**
   Given ключ, не встречающийся ни в `ROUTE_REGISTRY`, ни в policy, ни в `SYSTEM_ROLE_PERMISSIONS`;
   When гоняется `catalog-usage.spec.ts`;
   Then тест падает: право либо удаляется, либо помечается `deprecated`.

8. **Кросс-тенантность в матрице.**
   Given fixture с двумя организациями;
   When актор организации A обращается к каждому ресурсу организации B;
   Then во всех строках матрицы значение `deny:resource_not_found` (404), ни одного 403 и ни одного
   пустого 200.

9. **Инвалидация проверяется интеграционно.**
   Given пользователь и изменённая роль;
   When выполняется следующий запрос;
   Then права новые без перелогина (тест на живом Redis).

10. **E2E-подтверждение.**
    Given пользователь с ролью `viewer` в Playwright-прогоне;
    When он открывает `/admin/roles` по прямой ссылке;
    Then видит понятный экран 403 (не пустой экран и не «что-то пошло не так»), а кнопки
    редактирования на доступных экранах отсутствуют.

## Задачи

- [ ] `packages/server/test/permissions/permission-matrix.fixture.ts` — две организации, по
      пользователю на роль, набор ресурсов (`task.publicProject.memberEditable`, `invoice.draft`,
      `project.private`, `file.personal`, …), версионируется в поле `fixture` снапшота.
- [ ] `packages/server/test/permissions/permission-matrix.spec.ts` — обход `ROUTE_REGISTRY` ×
      7 ролей через supertest.
- [ ] `packages/server/test/permissions/__snapshots__/permission-matrix.json` +
      `permission-matrix.schema.json` (детерминированная сортировка по `method`, `path`).
- [ ] `packages/server/test/permissions/permission-matrix.serializer.ts` — человекочитаемый дифф с
      пометками `⚠ расширение прав` / `⚠ раскрытие существования`.
- [ ] `packages/server/test/permissions/catalog-usage.spec.ts` — п. 7.
- [ ] `.github/CODEOWNERS` — путь `packages/server/test/permissions/__snapshots__/**`.
- [ ] `.github/pull_request_template.md` — блок обоснования при расширении прав.
- [ ] `package.json` — скрипт `test:permissions` (+ `-u` для осознанного обновления).
- [ ] `packages/e2e/tests/permissions/viewer-restrictions.spec.ts` — п. 10 + axe-аудит экрана 403.

## Ссылки

- [`permission-model.md` §9а «Табличные тесты policy»](../../../docs/security/permission-model.md)
- [`permission-model.md` §9б «Permission-matrix snapshot test — главный предохранитель»](../../../docs/security/permission-model.md)
- [`permission-model.md` §9г «Агент permission-matrix-auditor», §9д «Что ещё обязательно покрыто»](../../../docs/security/permission-model.md)
- [`threat-model.md`, `T-TENANT-05`, `T-IAM-09`, план проверки «Автоматически (CI на каждый PR)»](../../../docs/security/threat-model.md)
- PRD: `R-15`, метрика «кросс-тенантные утечки = 0»

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
