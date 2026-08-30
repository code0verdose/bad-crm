---
id: STORY-011-09
epic: EPIC-011
status: review
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

## Что уже сделано (2026-08-05)

- [x] `packages/server/test/permissions/permission-matrix.test.ts` — каждая из 7 системных ролей
      вызывает каждый гейтящийся правом маршрут через supertest на **реальном HTTP-стеке**
      (гвард, use-case, policy), результат сравнивается с
      `test/permissions/__snapshots__/permission-matrix.json`. Ячейка хранит причину, а не голый
      deny (`deny:permission_not_granted`).
- [x] Направление изменения печатается словами: `⚠ расширение прав` для «отказ стал разрешением» и
      `⚠ раскрытие существования` для «404 стал 403». Проверено, что гейт падает: подменил ячейку в
      снапшоте — тест назвал изменение раскрытием существования.
- [x] Обновление снапшота — осознанное действие: `UPDATE_PERMISSION_MATRIX=1`.
- [x] `catalogSize` едет вместе с матрицей (п. 6 в части «каталог не разошёлся»).
- [x] `test/permissions/catalog-usage.test.ts` (п. 7) — право, которое никто не выдаёт и нигде не
      упоминается, роняет тест; обратное направление — ключ в коде, которого нет в каталоге, — тоже.

Отклонения от плана задач, с причинами:

- **Без Testcontainers и без семи реальных пользователей** (п. 1). ~~Сегодня в реестре четыре
  гейтящихся маршрута~~ — **число устарело, поправлено 2026-08-30: их 28** (печатает
  `node -e "const j=require('./packages/server/test/permissions/__snapshots__/permission-matrix.json');
  console.log(Object.keys(j.matrix.owner).length)"`; жёсткое число здесь и не нужно — оно росло с
  каждой историей EPIC-011/012). Довод при этом не изменился и остаётся верным: все 28 —
  capability-only (`requiredLevel = null` у каждого ключа, стоящего на маршруте; проверено сверкой
  списка маршрутов с каталогом), ресурсного слоя нет ни у одного домена. Матрица измеряет ровно то,
  что есть, — решение слоёв 1–3 — через подставленный набор прав роли; поднимать Postgres, чтобы
  записать те же права в `user_roles`, значит тратить минуту прогона на то же самое значение. Вторая
  размерность (ACL) добавляется вместе с первым ресурсным доменом (EPIC-014), и форма снапшота под
  это подготовлена.
- **CODEOWNERS (п. 5) не заведён** — в репозитории его нет вообще, и заводить его ради одной строки
  без владельцев остальных областей не стоит: это решение уровня проекта, а не истории. Уточнение
  2026-08-30: вторая половина пункта 5 (обоснование расширения прав в PR) частично закрыта не тем
  механизмом — `.github/pull_request_template.md:39,49` требует прогона `permission-matrix-auditor`
  и проверки «право объявлено, проверка в use-case, 404 вместо 403», но **отдельного пункта
  «расширение прав объяснено в описании PR» в шаблоне нет**. Гейт держится на агенте, не на
  процедуре ревью.
- Пункты 3 и 4 проверены руками на подменённом снапшоте; автоматического «теста на тест» нет
  намеренно — он проверял бы формулировку сообщения, а не свойство.

**Открытые критерии, названные явно (ревизия 2026-08-30).** Их не было в этом разделе, отчего
«не перечислено» читалось как «сделано»:

- **П. 8 — кросс-тенантная размерность матрицы не измеряется.** Фикстура строит одну организацию на
  ячейку; второй организации в матрице нет, поэтому строки «чужой объект → 404» в снапшоте не
  существует. Свойство при этом проверяется, но в другом месте и не по всем ресурсам сразу:
  `packages/e2e/tests/tenancy/cross-tenant-api.spec.ts` и точечные 404-тесты в HTTP-наборах каждого
  домена. Гейт есть, размерности матрицы — нет.
- **П. 9 — инвалидация против живого Redis не проверяется**, потому что проверять нечего: кеша прав
  не существует (см. [STORY-011-08](story-011-08-effective-permissions.md), раздел «Отложено»).
  Пункт открывается вместе с решением по кешу, не раньше.
- **П. 10 — Playwright-сценария «viewer на `/admin/roles` видит настоящий экран 403» нет.** В
  `packages/e2e/tests` сегодня `auth`, `rbac`, `smoke`, `tenancy`; сценария ограничений роли среди
  них нет. Ближайший родственник — `rbac/admin-user-overrides.spec.ts`, но он про другое (выдача и
  отзыв персонального исключения) и сам ни разу не проходил против живого приложения.

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
