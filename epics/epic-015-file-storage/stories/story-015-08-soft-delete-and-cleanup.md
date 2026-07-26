---
id: STORY-015-08
epic: EPIC-015
status: backlog
blocked: false
priority: should
estimate: M
---

# STORY-015-08 — Мягкое удаление, корзина и зачистка

**Как** разработчик (P4) **я хочу**, чтобы удалённый файл попадал в корзину и его можно было
вернуть, а брошенные загрузки и осиротевшие объекты в хранилище исчезали сами, **чтобы** случайное
удаление не было катастрофой, а диск не заполнялся мусором, о котором никто не знает.

## Acceptance (Given/When/Then)

1. **Мягкое удаление.**
   Given пользователь с `file:delete` и уровнем `EDITOR`;
   When `DELETE /api/v1/files/{fileId}`;
   Then проставляется `deletedAt = now`, файл исчезает из списков и из выдачи ссылок; объект в
   хранилище **не** удаляется; в `AuditLog` — `file.deleted` с `before`.

2. **Мягко удалённый файл невидим везде.**
   Given `deletedAt IS NOT NULL`;
   When любой репозиторий, отчёт или (в M4) поисковый индекс запрашивает данные;
   Then строка не возвращается; фильтр навешен через Prisma-`$extends`, а не расставлен руками;
   табличный тест `soft-deleted-invisible-in-all-repositories` покрывает все репозитории
   (`T-PROJ-03` по аналогии).

3. **Негативный сценарий — скачивание удалённого.**
   Given удалённый файл и валидный `fileId`;
   When запрашивается ссылка на скачивание;
   Then **404** `resource_not_found`, даже у владельца — восстановление сначала, скачивание потом.

4. **Корзина и восстановление.**
   Given экран корзины (`/files?deleted=1`);
   When пользователь с `file:restore` восстанавливает файл;
   Then `deletedAt = null`, файл возвращается в прежнюю папку; если папка удалена — в корень
   соответствующего скоупа с уведомлением; в `AuditLog` — `file.restored`.

5. **Физическое удаление по TTL.**
   Given файл в корзине дольше `FILE_TRASH_TTL_DAYS` (дефолт 30);
   When отрабатывает `purge-deleted-files.job.ts`;
   Then удаляются объекты всех версий из хранилища, затем строки из БД (в таком порядке —
   иначе остаются сироты в бакете); квота освобождается; событие `file.purged` с
   `actorType = SYSTEM`.

6. **Зачистка брошенных загрузок.**
   Given `File(status = pending)` старше `UPLOAD_PENDING_TTL_MINUTES` (дефолт 60);
   When отрабатывает `purge-pending-uploads.job.ts`;
   Then строка и (при наличии) объект удаляются; метрика `file_pending_purged_total` растёт
   (`T-FILE-08`).

7. **Зачистка сирот в бакете.**
   Given объект в хранилище без соответствующей строки в БД;
   When отрабатывает `reconcile-storage-objects.job.ts`;
   Then объект попадает в отчёт и удаляется **только** после карантинного периода (7 дней) —
   чтобы гонка «объект загружен, commit ещё не прошёл» не приводила к потере данных.

8. **Негативный сценарий — файл ещё используется.**
   Given файл приложен к задаче или сообщению (`Attachment`, `MessageAttachment`);
   When он физически удаляется джобом;
   Then удаление блокируется обратными индексами (`idx_attachments_file`) — сначала снимаются
   ссылки доменным сервисом каскада, и только потом файл; ночной integrity-джоб отдаёт **метрику и
   алерт** по сиротам, а не удаляет их тихо (`R-11`).

9. **Негативный сценарий — нет прав.**
   Given пользователь с `VIEWER` или без `file:delete`;
   When он удаляет файл;
   Then 403; корзина показывает только те файлы, к которым у пользователя есть доступ (та же
   проверка, что и для обычного списка).

10. **Идемпотентность джобов.**
    Given любой из джобов запускается повторно на тех же данных;
    When он отрабатывает;
    Then состояние не меняется, ошибок нет, метрики не задваиваются; обработка ведётся с
    tenant-контекстом **на каждую организацию отдельной транзакцией** (`T-PLAT-01`).

11. **UI корзины.**
    Given экран корзины;
    When он открыт;
    Then видны срок автоудаления по каждому файлу, действия «восстановить» и «удалить навсегда»
    (последнее — с подтверждением и правом `file:delete`), пустое состояние объясняет смысл;
    экран проходит axe и локализован EN/RU.

## Задачи

- [ ] `packages/server/src/application/file/use-cases/delete-file.use-case.ts`,
      `restore-file.use-case.ts`, `purge-file.use-case.ts` (окончательное удаление по запросу).
- [ ] `packages/server/src/application/platform/jobs/purge-deleted-files.job.ts`,
      `purge-pending-uploads.job.ts`, `reconcile-storage-objects.job.ts`,
      `file-integrity-check.job.ts` (сироты `Attachment` → метрика + алерт).
- [ ] `packages/server/src/infrastructure/persistence/prisma/soft-delete.extension.ts` — общий
      фильтр `deletedAt IS NULL` (совместно с
      [STORY-014-03](../../epic-014-project-core/stories/story-014-03-project-access.md)).
- [ ] `packages/server/src/domain/file/file-cascade.service.ts` — единственный доменный сервис
      каскадного удаления (файл → версии → ACL → вложения → объекты в хранилище) в одной транзакции.
- [ ] `packages/server/src/application/file/queries/list-trash.query.ts`.
- [ ] `packages/server/src/presentation/http/routes/registry.ts` — `file:delete`, `file:restore`.
- [ ] `packages/client/src/widgets/file-trash/file-trash.widget.tsx` +
      `ui/trash-item.component.tsx`, `ui/purge-confirm-dialog.component.tsx`;
      `units/file/service/mutations/{delete,restore}-file.mutation.ts` (оптимистичное удаление с
      откатом).
- [ ] i18n: `packages/client/src/app/i18n/{en,ru}/files.json`.
- [ ] Тесты: `file-cascade.service.spec.ts` (п. 8), `purge-deleted-files.job.spec.ts` (п. 5, 10),
      `purge-pending-uploads.job.spec.ts` (п. 6), `reconcile-storage-objects.job.spec.ts` (п. 7),
      `soft-deleted-invisible-in-all-repositories.spec.ts` (п. 2), интеграционный на п. 3,
      компонентный на корзину.

## Ссылки

- [`data-model.md`, группа 6 (частичные индексы `idx_files_deleted`), «Полиморфные связи»,
  «Мягкое удаление»](../../../docs/architecture/data-model.md)
- [`threat-model.md`, `T-FILE-08`, `T-PLAT-01`, `T-TASK-06`](../../../docs/security/threat-model.md)
- [`prd.md`, риск `R-11`, NFR-12 (жизненный цикл данных)](../../../docs/product/prd.md)
- [`permission-model.md` §3.8 (`file:delete`, `file:restore`)](../../../docs/security/permission-model.md)

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
