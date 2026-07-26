---
id: STORY-015-02
epic: EPIC-015
status: backlog
blocked: false
priority: must
estimate: L
---

# STORY-015-02 — Загрузка: presign и commit

**Как** разработчик (P4) **я хочу** загружать файлы напрямую в хранилище по ссылке, полученной от
приложения, **чтобы** большие файлы не проходили через API-процесс, а система всё равно знала о
каждом файле ровно то, что есть на самом деле, а не то, что заявил клиент.

## Acceptance (Given/When/Then)

1. **Выдача ссылки на загрузку.**
   Given пользователь с правом `file:upload` и уровнем ≥ `EDITOR` на цели (проект, папка, задача);
   When `POST /api/v1/files/presign` с `{ originalName, sizeBytes, mimeType, scope, scopeId,
   folderId? }`;
   Then проверяются capability + ACL цели, лимиты размера и whitelist MIME; создаётся
   `File(status = pending, storageKey = org/{orgId}/…)` и возвращается
   `{ fileId, uploadUrl, expiresIn: 300, requiredHeaders }`.

2. **Подпись ограничена.**
   Given выданная ссылка;
   When она проверяется;
   Then подпись включает **метод PUT**, точный ключ, `content-type` и `content-length-range`
   (±0 байт от заявленного); попытка PUT с другим типом, размером или ключом отклоняется самим
   хранилищем (`T-FILE-03`).

3. **Commit доверяет только HeadObject.**
   Given клиент загрузил тело и вызывает `POST /api/v1/files/{id}/commit`;
   When выполняется commit;
   Then сервер делает `HeadObject` по **своему** ключу и записывает фактические `sizeBytes`,
   `mimeType`, `checksumSha256`; заявленные клиентом значения не используются; в одной транзакции
   создаётся `FileVersion(version = 1)`, `File.status = ready` и `OutboxEvent`.

4. **Негативный сценарий — подмена ключа.**
   Given клиент передаёт `storageKey` чужого объекта в теле commit;
   When запрос обрабатывается;
   Then поле игнорируется (`.strict()`-схема его не содержит); дополнительно проверяется, что
   серверный ключ начинается с `org/{organizationId}/`, иначе 403 + запись в `AuditLog`
   (`T-FILE-01`).

5. **Негативный сценарий — тело не загружено.**
   Given commit вызывается без предшествующего PUT;
   When выполняется `HeadObject`;
   Then 409 `upload_not_found`; `File` остаётся `pending` и будет вычищен джобом.

6. **Негативный сценарий — размер не совпал.**
   Given фактический размер отличается от заявленного;
   When выполняется commit;
   Then 409 `size_mismatch`, объект удаляется из хранилища, `File` помечается к зачистке.

7. **Негативный сценарий — повторная запись по ключу.**
   Given файл уже закоммичен;
   When по тому же ключу выполняется повторный PUT или повторный commit;
   Then операция отклоняется: версии неизменяемы, новая версия — новый ключ
   ([STORY-015-06](story-015-06-file-versions.md)); повторный commit идемпотентен (200 без
   изменений).

8. **Негативный сценарий — нет прав на цель.**
   Given пользователь без `file:upload` или с уровнем `VIEWER` на проекте;
   When он запрашивает presign;
   Then 403 `permission_not_granted` / `insufficient_acl_level`; для несуществующей или чужой цели —
   **404** `resource_not_found`.

9. **Дедупликация внутри организации.**
   Given файл с тем же `checksumSha256` уже есть в этой организации;
   When выполняется commit;
   Then создаётся новая строка `File`, ссылающаяся на существующий объект (или помечается для
   дедупликации джобом); **между организациями дедупликация не выполняется никогда** —
   покрыто тестом `dedup-is-tenant-scoped` (`T-FILE-07`).

10. **`scanStatus` — часть жизненного цикла.**
    Given файл закоммичен;
    When `AntivirusPort` не сконфигурирован;
    Then `scanStatus = SKIPPED` для `scope = VAULT` и `PENDING` → `CLEAN` по политике для остальных;
    файл в `PENDING` **не отдаётся** на скачивание ни при каких правах (`T-FILE-05`).

11. **Аудит и наблюдаемость.**
    Given каждая выдача presign и каждый commit;
    When они выполняются;
    Then пишется `AuditLog` (`file.upload_presigned`, `file.committed`) с `fileId`, размером и
    актором — **без** самой ссылки; метрики `file_upload_total`, `file_upload_bytes` растут.

12. **UI-загрузка.**
    Given компонент загрузки;
    When пользователь перетаскивает файл;
    Then виден прогресс, ошибка типа/размера показывается до начала загрузки (валидация Zod по
    whitelist), отмена прерывает PUT через `AbortController`, повтор доступен одной кнопкой.

## Задачи

- [ ] `packages/server/prisma/migrations/*_files/migration.sql` — таблица `files`
      (`storage_key`, `original_name`, `mime_type`, `size_bytes bigint`, `checksum_sha256`, `scope`,
      `scope_id`, `folder_id`, `owner_id`, `scan_status`, `scanned_at`, `is_encrypted`,
      `current_version_id`, `status`, `deleted_at`), `uq_files_storage_key`,
      `idx_files_org_scope ... WHERE deleted_at IS NULL`, `idx_files_org_checksum`,
      частичный `idx_files_scan_pending`, RLS `ENABLE` + `FORCE` + политики.
- [ ] `packages/server/src/application/file/use-cases/presign-upload.use-case.ts`,
      `commit-upload.use-case.ts`.
- [ ] `packages/server/src/domain/file/access/file-access.policy.ts` — `canUpload` (capability ∧
      ACL цели), `file.errors.ts`.
- [ ] `packages/server/src/domain/file/mime-whitelist.ts` и `size-limits.ts` (совместно со
      [STORY-015-07](story-015-07-quotas-and-limits.md)).
- [ ] `packages/server/src/presentation/http/validators/file-upload.validator.ts` — Zod `.strict()`.
- [ ] `packages/server/src/presentation/http/routes/registry.ts` — `file:upload` с `aclCheckedIn`.
- [ ] `packages/client/src/units/file/service/hooks/use-file-upload.hook.ts` (presign → PUT →
      commit, прогресс, отмена), `service/mutations/*`, `shared/ui/file-dropzone.component.tsx`.
- [ ] Тесты: `file-access.policy.spec.ts`, интеграционные `commit-ignores-client-key.spec.ts` (п. 4),
      `presigned-put-constraints.spec.ts` (п. 2, 6, 7), `dedup-is-tenant-scoped.spec.ts` (п. 9),
      `pending-file-not-downloadable.spec.ts` (п. 10), isolation-тест `files`,
      компонентный на п. 12.

## Ссылки

- [`overview.md`, «(г) Файловый путь» (последовательность presign → PUT → commit)](../../../docs/architecture/overview.md)
- [`threat-model.md`, `T-FILE-01`, `T-FILE-03`, `T-FILE-05`, `T-FILE-07`, «Файлы и presigned URL»](../../../docs/security/threat-model.md)
- [`data-model.md`, группа 6 «Файлы», индексы, `scanStatus`, `checksumSha256`](../../../docs/architecture/data-model.md)
- [`permission-model.md` §3.8 (`file:upload` — `EDITOR`)](../../../docs/security/permission-model.md)

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
