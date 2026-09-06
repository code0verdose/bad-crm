---
id: STORY-014-03
epic: EPIC-014
status: in-progress
blocked: false
priority: must
estimate: L
---

# STORY-014-03 — Права на проект и наследование на дочерние ресурсы

**Как** руководитель проекта (P2) **я хочу**, чтобы доступ к проекту автоматически распространялся
на всё, что внутри него, и чтобы закрытый проект не проглядывал ни через один побочный экран,
**чтобы** «приватный» означало приватный, а не «не показан в основном списке».

> **Сверено с кодом 2026-09-06.** История написана 2026-07-26, до EPIC-011 и журнала действий.
> Текст ниже оставлен как запись замысла; расхождения с деревом — здесь.
>
> **Пути и имена.**
> - Каталога `domain/<контекст>/policies/` не существует. Принято `domain/<контекст>/access/*.policy.ts`
>   (десять образцов в `domain/iam/access/`, четыре в `domain/identity/access/`). Это не косметика:
>   пороги покрытия 100/100 в `packages/server/vitest.config.ts:59,63` стоят ровно на
>   `src/domain/**/access/*.policy.ts` и `src/domain/access/**`, поэтому `visible-projects.ts` вне
>   `access/` порогом не охватится и «единственная функция видимости» окажется единственной
>   непокрытой. Правильный адрес — `domain/project/access/visible-projects.policy.ts`.
> - Серверные тесты — `*.test.ts` в `packages/server/test/**`; `.spec.ts` носят только сценарии
>   `packages/e2e` (там имя из состава остаётся верным).
> - `infrastructure/persistence/prisma/soft-delete.extension.ts` не существует, и единственный
>   `$extends` во всём дереве — `tenant-guard.adapter.ts:59`. Требование мягкого удаления верно
>   (`data-model.md`, «Мягкое удаление»; флаг `softDeleted` в `tenant-tables.constant.ts`), но
>   критерий 11 — работа с нуля, а не подключение к существующему расширению.
>
> **Критерии без предмета — выносятся, а не получают заглушку.** Приём тот же, что применён в
> [STORY-011-07](../../epic-011-rbac-permissions/stories/story-011-07-policy-layer.md) (критерий 5,
> «Предмета нет… вынесено в EPIC-014») и в
> [STORY-012-07](../../epic-012-employee-management/stories/story-012-07-teams.md).
>
> | Критерий | Почему без предмета | Адресат |
> |---|---|---|
> | 1, в части `BOARD`, `TASK`, `FILE`, `FILE_FOLDER`, `CHANNEL`, `SPRINT` | Ни одного из этих доменов в коде нет. Регистрация шести цепочек была бы шестью фикстурами, а «проверяется интеграционным тестом на каждой реальной цепочке» — неисполнимо | доски и задачи — M3 (EPIC-018/019), файлы — EPIC-015, каналы — M4 |
> | 2 (`ResourceAcl(DOC_PAGE, …)`) | `DocPage` в продукте нет | EPIC-022 (документы) |
> | 3 (`ResourceAcl(FILE, …)`) | `File` в продукте нет, storage-адаптер не подключён | EPIC-015 (файлы) |
>
> Здесь регистрируется **одна** цепочка — `PROJECT → ORGANIZATION`, — и она же становится первым
> предметом ресурсного слоя, ради которого
> [STORY-011-06](../../epic-011-rbac-permissions/stories/story-011-06-resource-acl.md) стояла
> `blocked: true` (снято kickoff'ом 2026-09-06). Критерии 4, 5, 8, 9, 10, 11 предмет имеют и
> остаются в силе целиком.
>
> **Развилка наследования, которую история не называет.** `Board.projectId` **нуллабелен**
> (`docs/architecture/data-model.md:1082-1089`): свободная доска команды существует без проекта.
> Поэтому цепочка раздваивается — `Board → Project → Organization` у проектной доски и
> `Board → Organization` напрямую у свободной, — и резолвер обязан выбирать ветку по
> `projectId IS NULL`, а не предполагать проект. Сегодня это задел (досок нет), но форма регистрации
> цепочек закладывается здесь, и если она допускает только один корень, EPIC-018 обнаружит это
> поздно и дорого.
>
> **Снапшот матрицы прав.** Критерий 6 предполагает, что подмена 404 на 403 различима в снимке.
> Сегодня **каждая ячейка снапшота — capability-решение**: middleware зовёт только
> `authorizeCapability`, а use-case с резолвером на маршруте не стоит; докстринг говорит это
> (`packages/server/test/permissions/permission-matrix.test.ts:29-33`, «What this cannot see yet»).
> Формулировка «`requiredLevel` равен `null` у всех ключей на маршрутах» неверна:
> `organization:manage_security_policy` несёт `MANAGER` и стоит на трёх маршрутах — снята
> 2026-09-06.
> У `project:*` уровни в каталоге проставлены, поэтому первый такой маршрут делает снимок двумерным:
> снапшот придётся переснять и, возможно, добавить ось ресурса. Выбор кода 404/403 при этом уже
> сделан в одном месте и закреплён архитектурным тестом
> (`domain/access/access.errors.ts:50,54`, `test/unit/architecture/access-denial.test.ts:36`) —
> критерий 6 наследует эту точку, а не заводит вторую.
>
> **Коды и журнал.** `project_archived` в `packages/shared/src/errors/error-code.enums.ts`
> отсутствует — каталог закрытый, новый код это отдельное решение с переводом на обоих языках.
> `permission_not_granted`, `insufficient_acl_level`, `acl_resolution_failed` и
> `resource_not_found` из критериев 6 и 7 — это `DenyReason`
> (`packages/shared/src/permissions/deny-reason.enums.ts`), они существуют. Аудит **отказов** в
> доступе с 2026-09-06 есть — `access.denied`/`access.denial_burst` в каталоге действий, отбор в
> `domain/access/denied-access-audit.policy.ts`; формулировка «нет вовсе» держалась здесь до того
> же дня и снята (адресат был [STORY-016-02](../../epic-016-audit-log/stories/story-016-02-audit-logger-port.md),
> acceptance 7).
>
> **Сделано 2026-09-06 — policy и первое ресурсное чтение.**
> `domain/project/access/project-access.policy.ts` существует: `decideProjectAccess(actor, key,
> facts)` — capability через `authorizeWith`, резолвер только после неё, удалённая строка →
> `missing`, `NONE` на цепочке → `resource_not_found` (критерий 6 — закрытый контур);
> `canReadProject`; `projectAddressable`/`assertProjectAddressable`. Неявная таблица §5 в policy
> **не** переписана — её уже применяет резолвер (`implicit-level.policy.ts`), policy берёт готовый
> `AclScope` и `ProjectScope` из `scope()`. Первое чтение —
> `application/project/use-cases/get-project-detail.query.ts` (`project:read`, порядок «scope и
> цепочка → решение → `detail()`»). Из четырёх функций состава сделана та, у которой есть
> потребитель; `canUpdateProject`, `canManageProject`, `canArchiveProject` приходят со своими
> use-case'ами, а таблица уровней для `project:update`/`project:delete` уже стоит в
> `test/unit/domain/project/project-access-policy.test.ts`. Критерии 6 и 7 закрыты **в policy-части**
> на этом чтении: три неразличимых 404 с контролем на живой базе
> (`test/integration/db/project-read-access.test.ts`) и 503 при отказе резолвера — пока только
> двойником `{ status: 'unavailable' }` (`get-project-detail.query.test.ts`), живой отказ базы не
> воспроизводился. Снапшотная половина критерия 6 («⚠ раскрытие существования» в
> `permission-matrix`) ждёт маршрута. Маршрута
> ещё нет — он следующий шаг вместе с описаниями права, спекой и снапшотом матрицы. Открытыми
> остаются 4, 5, 8, 9, 10, 11 и `visible-projects.policy.ts`.

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

- [x] `packages/server/src/domain/project/access/project-access.policy.ts` — `decideProjectAccess`
      и `canReadProject` c `Decision` (2026-09-06); `canUpdateProject`, `canManageProject`,
      `canArchiveProject` — вместе с их use-case'ами, поверх той же `decideProjectAccess`.
- [ ] `packages/server/src/domain/project/policies/visible-projects.ts` — единственная функция
      видимости (чистая, на вход — принципалы и записи ACL).
- [ ] ~~`packages/server/src/application/project/ports/project-access-reader.port.ts`~~ — второй
      порт не заводится (2026-09-06): ридер проекта живёт в
      `application/access/ports/project-access-reader.port.ts` и читается только резолвером, policy
      берёт `scope()` репозитория и `AclScope`. `accessibleProjectIds` — вместе с
      `visible-projects.policy.ts`, отдельным портом списка, а не ридера доступа.
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
