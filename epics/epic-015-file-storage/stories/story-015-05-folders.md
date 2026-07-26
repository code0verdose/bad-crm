---
id: STORY-015-05
epic: EPIC-015
status: backlog
blocked: false
priority: should
estimate: M
---

# STORY-015-05 — Папки и навигация

**Как** разработчик (P4) **я хочу** раскладывать файлы по папкам и ходить по ним как по дереву,
**чтобы** проектное хранилище не превращалось в свалку из трёхсот файлов с именами
`итоговый_final_v3.pdf`.

## Acceptance (Given/When/Then)

1. **Создание папки.**
   Given пользователь с `file:manage_folders` и уровнем `EDITOR` на цели;
   When `POST /api/v1/file-folders` с `{ name, parentFolderId?, scope, scopeId? }`;
   Then создаётся `FileFolder` с materialized `path` вида `/{rootId}/{parentId}/{id}`; имя уникально
   среди сиблингов (регистронезависимо).

2. **Навигация по дереву.**
   Given экран `/files?folder={id}`;
   When пользователь открывает папку;
   Then текущая папка живёт в URL (schema `fileListSearchSchema`), хлебные крошки строятся
   **разбором `path`** без дополнительных запросов, содержимое грузится одним запросом
   (папки + файлы), без N+1.

3. **Перемещение поддерева.**
   Given папка с 50 вложенными файлами и 3 подпапками;
   When она перемещается в другую папку;
   Then `path` обновляется одним `UPDATE ... SET path = replace(path, $old, $new) WHERE path LIKE
   $old || '%'` в одной транзакции; доступ пересчитывается по новой цепочке со следующего запроса.

4. **Негативный сценарий — цикл.**
   Given попытка переместить папку внутрь собственного потомка;
   When операция выполняется;
   Then 422 `folder_cycle_detected` (проверка по `path` — целевой путь не может начинаться с пути
   перемещаемой папки).

5. **Негативный сценарий — смена скоупа перемещением.**
   Given папка `scope = PROJECT (p1)`;
   When она перемещается в папку `scope = PERSONAL`;
   Then 422 `scope_mismatch`: смена скоупа — отдельная явная операция
   ([STORY-015-04](story-015-04-file-scopes-access.md)), а не побочный эффект drag-and-drop.

6. **Негативный сценарий — path traversal.**
   Given имя папки содержит `../`, ведущий `/`, NUL или управляющие символы;
   When приходит запрос;
   Then 422: имя валидируется Zod-схемой, а `path` **строит сервер** из идентификаторов, а не из
   пользовательских имён; ключ объекта в S3 никогда не зависит от имени папки (`T-KNOW-02` по
   аналогии).

7. **Негативный сценарий — нет прав.**
   Given пользователь с `VIEWER` на проекте;
   When он создаёт, переименовывает или перемещает папку;
   Then 403 `insufficient_acl_level`; чтение при этом разрешено.

8. **Удаление папки.**
   Given папка с содержимым;
   When она удаляется;
   Then показывается сводка «N файлов и M подпапок будут перемещены в корзину», требуется
   подтверждение; удаление выполняется одним доменным сервисом каскада в одной транзакции
   (файлы → мягкое удаление, ACL папки → удаление), запись в `AuditLog` (`R-11`).

9. **Точечные права на папку.**
   Given `ResourceAcl(FILE_FOLDER, TEAM=backend, EDITOR)` внутри проекта с уровнем `VIEWER`;
   When член команды открывает папку;
   Then он получает `EDITOR` на её содержимое (ближайшая явная запись побеждает), в остальных
   папках остаётся `VIEWER`.

10. **Drag & drop.**
    Given список файлов и дерево папок;
    When файл перетаскивается в папку;
    Then изменение оптимистично (`onMutate` → патч кеша, `onError` → откат, `onSettled` →
    инвалидация); есть эквивалентный путь с клавиатуры (перемещение через меню) — обязательное
    требование a11y.

11. **Производительность.**
    Given 10 000 файлов в проекте;
    When открывается папка;
    Then p95 < 300 мс; запрос покрыт `idx_file_folders_org_parent` и
    `idx_files_org_scope ... WHERE deleted_at IS NULL`; длинные списки виртуализируются.

## Задачи

- [ ] `packages/server/prisma/migrations/*_file_folders/migration.sql` — `file_folders`
      (`name`, `parent_folder_id`, `path`, `scope`, `scope_id`, `owner_id`, `deleted_at`),
      `idx_file_folders_org_parent`, индекс по `path` (`text_pattern_ops` для `LIKE`),
      уникальность имени среди сиблингов, RLS `ENABLE` + `FORCE` + политики.
- [ ] `packages/server/src/domain/file/folder-path.value.ts` — построение и разбор `path`,
      `assertNoCycle`.
- [ ] `packages/server/src/application/file/use-cases/create-folder.use-case.ts`,
      `rename-folder.use-case.ts`, `move-folder.use-case.ts`, `delete-folder.use-case.ts`.
- [ ] `packages/server/src/application/file/queries/list-folder-content.query.ts` (папки + файлы
      одним запросом), `get-breadcrumbs.query.ts` (из `path`, без запросов).
- [ ] `packages/server/src/presentation/http/routes/registry.ts` — `file:manage_folders`,
      `file:read` c `aclCheckedIn`.
- [ ] `packages/client/src/units/file/service/hooks/use-file-browser.hook.ts` (URL, папка, фильтры,
      debounce), `service/mutations/move-file.mutation.ts` (оптимистично).
- [ ] `packages/client/src/widgets/file-browser/file-browser.widget.tsx` +
      `ui/folder-tree.component.tsx`, `ui/file-list.component.tsx`,
      `ui/breadcrumbs.component.tsx`, `ui/move-to-folder-menu.component.tsx`.
- [ ] i18n: `packages/client/src/app/i18n/{en,ru}/files.json`.
- [ ] Тесты: `folder-path.value.spec.ts` (п. 4, 6), интеграционные `move-folder-subtree.spec.ts`
      (п. 3), `delete-folder-cascade.spec.ts` (п. 8), `folder-acl-inheritance.spec.ts` (п. 9),
      isolation-тест `file_folders`, e2e drag & drop + клавиатурная альтернатива (п. 10) + axe.

## Ссылки

- [`data-model.md`, группа 6, `FileFolder.path`; «Индексы и производительность»](../../../docs/architecture/data-model.md)
- [`permission-model.md` §6 (цепочка `File → FileFolder(родители) → Project`)](../../../docs/security/permission-model.md)
- [`ux-architecture.md`, `/files`, «Drag & drop», «Виртуализация»](../../../docs/architecture/ux-architecture.md)
- [`threat-model.md`, `T-KNOW-02` (path traversal), `R-11`](../../../docs/security/threat-model.md)

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
