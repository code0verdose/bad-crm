---
id: STORY-016-04
epic: EPIC-016
status: backlog
blocked: false
priority: should
estimate: M
---

# STORY-016-04 — Экспорт журнала

**Как** владелец инсталляции (P1) **я хочу** выгрузить журнал за период в машиночитаемом виде,
**чтобы** приложить его к аудиту заказчика или к разбору инцидента, — и чтобы сам факт выгрузки
тоже остался в журнале.

## Acceptance (Given/When/Then)

1. **Экспорт по фильтру.**
   Given администратор с правом `audit:export` (`dangerous`);
   When `POST /api/v1/audit/export` с теми же фильтрами, что на экране просмотра, и форматом
   `csv | jsonl`;
   Then запускается фоновая задача, возвращается `exportId`; по готовности файл доступен по
   presigned-ссылке с TTL ≤ 300 c (через [EPIC-015](../../epic-015-file-storage/epic.md)).

2. **Экспорт логируется как критичное событие.**
   Given выгрузка запущена;
   When задача завершилась;
   Then в `AuditLog` — `audit.exported` с `severity = critical`, полем `filter` и фактическим
   `rowCount`; отсутствие такой записи ломает тест.

3. **Негативный сценарий — нет права.**
   Given администратор с `audit:read`, но без `audit:export`;
   When он вызывает экспорт;
   Then 403 `permission_not_granted`; кнопка в UI отсутствует.

4. **Негативный сценарий — экспорт событий безопасности без права.**
   Given пользователь с `audit:export`, но без `audit:read_security`;
   When он выгружает журнал;
   Then события безопасности в файл **не попадают**, а в ответе указано, сколько строк было
   отфильтровано по правам — без раскрытия их содержимого.

5. **Границы объёма.**
   Given фильтр, попадающий на 5 млн строк;
   When запускается экспорт;
   Then задача либо ограничивается лимитом строк/периода с понятной ошибкой, либо выполняется
   потоково с чанками и не удерживает всю выборку в памяти; выбранный вариант зафиксирован тестом
   потребления памяти.

6. **Негативный сценарий — секреты в выгрузке.**
   Given записи с `before`/`after`;
   When формируется файл;
   Then применяется тот же whitelist полей, что и при записи и при просмотре; grep-тест по
   выгруженному файлу не находит паттернов секретов (`T-PLAT-06`).

7. **Ссылка на файл ограничена.**
   Given готовый файл экспорта;
   When выдаётся ссылка;
   Then это `scope = ORG`-файл с ограничением доступа по праву `audit:export`, TTL ≤ 300 c,
   `Content-Disposition: attachment`; повторная выдача требует повторной проверки прав.

8. **Rate limiting и квота.**
   Given частые выгрузки;
   When превышен лимит (например, 3 экспорта в час на организацию);
   Then 429 с `Retry-After`; экспортные файлы учитываются в квоте хранилища и удаляются джобом
   через заданный TTL.

9. **Кросс-тенантность.**
   Given экспорт запущен в организации A;
   When формируется выборка;
   Then в файле нет ни одной строки организации B (tenant-контекст выставляется на каждый чанк —
   `T-PLAT-01`).

10. **Уведомление о выгрузке.**
    Given экспорт завершён;
    When задача закончилась;
    Then инициатор получает in-app уведомление, а владельцы организации — уведомление о факте
    выгрузки журнала (это событие, о котором должны знать не только его инициаторы).

11. **UI.**
    Given экран `/admin/audit`;
    When администратор нажимает «Экспорт»;
    Then показывается сводка «будет выгружено ~N строк за период …», требуется подтверждение,
    прогресс отображается, готовый файл скачивается одной кнопкой; экран локализован EN/RU и
    проходит axe.

## Задачи

- [ ] `packages/server/src/application/platform/use-cases/start-audit-export.use-case.ts` +
      джоб `audit-export.job.ts` (потоковая выгрузка чанками, tenant-контекст на чанк).
- [ ] `packages/server/src/application/platform/queries/estimate-audit-export.query.ts` (п. 11).
- [ ] `packages/server/src/infrastructure/export/csv-writer.ts`, `jsonl-writer.ts` (потоковые).
- [ ] Интеграция с `FileStoragePort`: запись результата в `scope = ORG`, выдача ссылки через
      `issue-download-url.use-case.ts` с дополнительной проверкой `audit:export`.
- [ ] `packages/server/src/application/platform/audit/audit-field-whitelist.ts` — переиспользование.
- [ ] `packages/server/src/infrastructure/rate-limit/audit-export.limiter.ts`.
- [ ] `packages/server/src/presentation/http/routes/registry.ts` — `audit:export`.
- [ ] `packages/client/src/widgets/audit-log/ui/audit-export-dialog.component.tsx`,
      `units/audit/service/mutations/start-audit-export.mutation.ts`,
      `service/hooks/use-audit-export.hook.ts` (поллинг статуса, один тост на операцию).
- [ ] i18n: `packages/client/src/app/i18n/{en,ru}/audit.json`.
- [ ] Тесты: `start-audit-export.use-case.spec.ts` (п. 2–4), `audit-export.job.spec.ts` (п. 5, 9),
      grep-тест выгруженного файла (п. 6), интеграционный на п. 7, 8, e2e + axe.

## Ссылки

- [`permission-model.md` §10 «Кто может смотреть» (`audit:export` — `dangerous`, само действие
  логируется как `critical`), §3.17](../../../docs/security/permission-model.md)
- [`threat-model.md`, `T-PLAT-06`, `T-PLAT-01`, `T-KNOW-07` (эксфильтрация через экспорт)](../../../docs/security/threat-model.md)
- [`data-model.md`, группа 14](../../../docs/architecture/data-model.md)
- [`prd.md`, NFR-6, NFR-12 (экспорт данных как обязательная функция)](../../../docs/product/prd.md)

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
