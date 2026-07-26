---
id: STORY-015-04
epic: EPIC-015
status: backlog
blocked: false
priority: must
estimate: L
---

# STORY-015-04 — Скоупы файлов и наследование доступа

**Как** разработчик (P4) **я хочу**, чтобы мои личные файлы были действительно личными, проектные
были видны команде проекта, а вложение задачи наследовало доступ задачи, **чтобы** не думать о
правах на каждый файл отдельно и не бояться, что личный черновик увидит вся организация.

## Acceptance (Given/When/Then)

1. **Шесть скоупов с разными правилами.**
   Given `scope ∈ {ORG, PROJECT, PERSONAL, TASK, CHAT, VAULT}` и `scopeId`;
   When резолвится доступ;
   Then `ORG` — от организации, `PROJECT` — от проекта, `TASK` — от задачи (через доску и проект),
   `CHAT` — от канала, `PERSONAL` — только владелец, `VAULT` — авторитет `VaultMembership`
   (`ResourceAcl` не участвует); правило выбора реализовано одной функцией и покрыто табличным
   тестом на все шесть значений.

2. **Наследование от папки и проекта.**
   Given файл в папке проекта без собственной записи ACL;
   When резолвится уровень;
   Then применяется цепочка `File → FileFolder(родители по `path`) → Project → Organization` с
   правилом «ближайшая явная запись побеждает»; резолв — один SQL-запрос.

3. **Личный файл.**
   Given `scope = PERSONAL`, `ownerId = ivan`;
   When Иван обращается к файлу → `implicitLevel = MANAGER`;
   When обращается кто угодно другой, включая администратора → `NONE` → **404**;
   Then владелец организации также не получает доступ автоматически к личным файлам через обход ACL
   (исключение фиксируется тестом и документируется).

4. **Негативный сценарий — вложение переживает отзыв доступа.**
   Given файл приложен к задаче и пользователь потерял доступ к задаче;
   When он запрашивает файл **по прямому `fileId`**;
   Then 404: чтение вложения **всегда** резолвит родителя и проверяет права на него; тест
   `polymorphic-parent-check` (задача → вложение → отзыв доступа → 404) обязателен
   (`T-TASK-06`, `R-11`).

5. **Негативный сценарий — файл, приложенный в нескольких местах.**
   Given один `File` приложен к задаче A (доступна) и к каналу B (недоступен);
   When пользователь обращается к файлу в контексте B;
   Then 404; в контексте A — доступ разрешён. Доступ вычисляется **по контексту обращения**, а не
   «есть хотя бы где-то».

6. **Негативный сценарий — точечный запрет.**
   Given `ResourceAcl(FILE_FOLDER, USER=ivan, NONE)` внутри проекта, где у Ивана `EDITOR`;
   When он открывает файл из этой папки;
   Then 404; остальные папки проекта остаются доступными.

7. **Точечная выдача.**
   Given `ResourceAcl(FILE, USER=guest, VIEWER)` в приватном проекте;
   When гость открывает этот файл по прямой ссылке;
   Then доступ разрешён только к нему; папка, проект и соседние файлы — 404.

8. **Смена скоупа = смена прав.**
   Given файл перемещается из `PERSONAL` в `PROJECT`;
   When операция выполняется (`file:update`, уровень `EDITOR` на цели);
   Then `scope`/`scopeId`/`folderId` обновляются в одной транзакции, событие в `AuditLog`, доступ
   пересчитывается со следующего запроса; обратное перемещение (в личное) требует владения файлом.

9. **Списки не резолвят построчно.**
   Given список из 200 файлов;
   When он строится;
   Then множество доступных проектов и папок вычисляется один раз, `WHERE ... = ANY($accessible)` с
   вычитанием поддеревьев `NONE`; тест «список = фильтр по `can()` построчно» проходит.

10. **Кросс-тенантность.**
    Given `fileId` организации B;
    When пользователь организации A запрашивает метаданные или ссылку;
    Then **404**; isolation-тест `files` и `permission-matrix` это подтверждают.

## Задачи

- [ ] `packages/server/src/application/file/ports/file-access-reader.port.ts` — `fileScope(fileId)`
      (возвращает `{ fileId, organizationId, scope, scopeId, folderPath, ownerId, aclLevel,
      scanStatus, isDeleted }`, `null` → 404) и `accessibleFolderIds(actor)`.
- [ ] `packages/server/src/infrastructure/persistence/prisma/file-access-reader.adapter.ts` +
      `sql/resolve-file-acl.query.sql` (один round-trip, разбор `FileFolder.path`).
- [ ] `packages/server/src/domain/file/access/file-scope-rules.ts` — чистая функция выбора цепочки
      по `scope` (шесть веток).
- [ ] `packages/server/src/domain/access/implicit-level.ts` — ветки `File.scope = PERSONAL`
      (владелец → `MANAGER`, иначе `NONE`).
- [ ] `packages/server/src/application/file/use-cases/move-file-scope.use-case.ts`.
- [ ] `packages/server/src/application/access/services/ancestor-chain.service.ts` — регистрация
      цепочек `FILE` и `FILE_FOLDER`.
- [ ] Тесты: `file-scope-rules.spec.ts` (шесть скоупов), `file-access.policy.spec.ts` (п. 3, 6, 7),
      интеграционные `polymorphic-parent-check.spec.ts` (п. 4), `file-context-access.spec.ts` (п. 5),
      `file-list-consistency.spec.ts` (п. 9), `resolve-file-acl-single-query.spec.ts`.

## Ссылки

- [`permission-model.md` §6 «Наследование ACL» (цепочка `File → FileFolder → Project`), §5
  `implicitLevel` (личный ресурс)](../../../docs/security/permission-model.md)
- [`data-model.md`, группа 6 («Про `scope` + `scopeId`»), «Полиморфные связи»](../../../docs/architecture/data-model.md)
- [`threat-model.md`, `T-TASK-06`, `T-FILE-02`, `T-TENANT-05`](../../../docs/security/threat-model.md)
- [`prd.md`, риск `R-11`](../../../docs/product/prd.md)

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
