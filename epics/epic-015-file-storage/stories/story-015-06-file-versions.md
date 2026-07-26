---
id: STORY-015-06
epic: EPIC-015
status: backlog
blocked: false
priority: should
estimate: M
---

# STORY-015-06 — Версии файла

**Как** руководитель проекта (P2) **я хочу**, чтобы загрузка новой редакции документа создавала
версию, а не затирала предыдущую, **чтобы** «случайно залил не тот файл» решалось откатом, а не
поиском копии в почте.

## Acceptance (Given/When/Then)

1. **Новая версия — новый объект.**
   Given существующий файл с `version = 1`;
   When пользователь с `file:manage_versions` (уровень `EDITOR`) загружает новую редакцию через
   presign → commit;
   Then создаётся `FileVersion(version = 2)` с **новым** `storageKey`, `File.currentVersionId`
   обновляется в той же транзакции; предыдущий объект не перезаписывается (immutable-версии).

2. **История версий.**
   Given файл с 5 версиями;
   When запрашивается `GET /api/v1/files/{fileId}/versions`;
   Then возвращается список с номером, размером, `checksumSha256`, автором, датой и комментарием;
   доступ требует `file:read` и того же уровня ACL, что и сам файл.

3. **Скачивание конкретной версии.**
   Given версия 2;
   When запрашивается ссылка на неё;
   Then права проверяются заново по текущему состоянию файла (не по состоянию на момент загрузки
   версии), выдаётся presigned GET с тем же TTL и теми же заголовками, что в
   [STORY-015-03](story-015-03-presigned-download.md).

4. **Откат.**
   Given текущая версия 5, нужно вернуть 3;
   When выполняется `POST /api/v1/files/{fileId}/versions/{versionId}/restore`;
   Then создаётся **новая** версия 6 с тем же содержимым (копирование объекта в хранилище через
   `copyObject`), а не переставляется указатель назад — история остаётся линейной и полной;
   в `AuditLog` — `file.version_restored`.

5. **Негативный сценарий — конкурентная загрузка.**
   Given два пользователя одновременно коммитят новую версию;
   When обе транзакции выполняются;
   Then номера версий не конфликтуют: `uq_file_versions (file_id, version)` + вычисление номера
   внутри транзакции (`SELECT max(version) ... FOR UPDATE` или счётчик на `File`); проигравшая
   транзакция повторяется, обе версии сохраняются, ни одна не теряется (конкурентный тест).

6. **Негативный сценарий — повторная запись по ключу версии.**
   Given ключ уже закоммиченной версии;
   When по нему выполняется PUT;
   Then отклоняется (подпись выдаётся только на новый ключ, `T-FILE-03`).

7. **Негативный сценарий — нет прав.**
   Given пользователь с `VIEWER`;
   When он загружает новую версию или откатывает;
   Then 403 `insufficient_acl_level`; чтение истории при этом разрешено.

8. **Удаление версии.**
   Given старая версия;
   When она удаляется (`file:manage_versions`, подтверждение);
   Then строка помечается удалённой, объект в хранилище удаляется джобом; **текущую версию удалить
   нельзя** (409 `current_version_immutable`).

9. **Квота учитывает все версии.**
   Given файл с 5 версиями по 10 МБ;
   When считается потребление организации;
   Then учитываются все 50 МБ; при превышении квоты загрузка новой версии отклоняется с 413
   (стыковка со [STORY-015-07](story-015-07-quotas-and-limits.md)).

10. **UI истории.**
    Given панель версий на `/files/$fileId`;
    When она открыта;
    Then версии перечислены от новых к старым, у каждой — скачать/откатить/удалить под `<Can>`,
    подтверждение для отката и удаления, состояния loading/empty/error реализованы через
    `shared/ui/data-state`; экран проходит axe и локализован EN/RU.

## Задачи

- [ ] `packages/server/prisma/migrations/*_file_versions/migration.sql` — `file_versions`
      (`file_id`, `version`, `storage_key`, `size_bytes`, `checksum_sha256`, `uploaded_by_id`,
      `comment`, `deleted_at`), `uq_file_versions (file_id, version)`,
      `files.current_version_id` FK, RLS `ENABLE` + `FORCE` + политики.
- [ ] `packages/server/src/application/file/use-cases/commit-new-version.use-case.ts`,
      `restore-file-version.use-case.ts`, `delete-file-version.use-case.ts`.
- [ ] `packages/server/src/application/file/queries/list-file-versions.query.ts`.
- [ ] `packages/server/src/domain/file/version-number.ts` — вычисление следующего номера под
      блокировкой строки файла.
- [ ] `packages/server/src/application/file/ports/file-storage.port.ts` — использование
      `copyObject` для отката.
- [ ] `packages/server/src/presentation/http/routes/registry.ts` — `file:manage_versions`.
- [ ] `packages/client/src/units/file/service/{queries,mutations}` — `file-versions.query.ts`,
      `restore-file-version.mutation.ts` (пессимистично);
      `widgets/file-versions/file-versions.widget.tsx` + `ui/file-version-row.component.tsx`.
- [ ] i18n: `packages/client/src/app/i18n/{en,ru}/files.json`.
- [ ] Тесты: `version-number.spec.ts`, конкурентный `concurrent-version-commit.spec.ts` (п. 5),
      интеграционные `restore-version.spec.ts` (п. 4), `delete-current-version-forbidden.spec.ts`
      (п. 8), isolation-тест `file_versions`, компонентный на панель версий.

## Ссылки

- [`data-model.md`, группа 6, `FileVersion`, `uq_file_versions`](../../../docs/architecture/data-model.md)
- [`threat-model.md`, `T-FILE-03` («повторный PUT по тому же ключу запрещён — immutable-версии»)](../../../docs/security/threat-model.md)
- [`permission-model.md` §3.8 (`file:manage_versions` — `EDITOR`)](../../../docs/security/permission-model.md)
- [`ux-architecture.md`, `/files/$fileId`, «Подтверждение разрушающих действий»](../../../docs/architecture/ux-architecture.md)

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
