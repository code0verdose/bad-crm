---
id: STORY-015-07
epic: EPIC-015
status: backlog
blocked: false
priority: must
estimate: M
---

# STORY-015-07 — Квоты, лимиты и типы файлов

**Как** владелец инсталляции (P1) **я хочу** ограничивать суммарный объём хранилища организации,
размер отдельного файла и допустимые типы, **чтобы** диск сервера не заканчивался внезапно, а
пользователи получали понятную ошибку до начала загрузки, а не после.

## Acceptance (Given/When/Then)

1. **Квота организации.**
   Given `storageQuotaBytes` в настройках организации (дефолт из env);
   When пользователь запрашивает presign, а текущее потребление + заявленный размер превышают квоту;
   Then 413 `storage_quota_exceeded` с телом, содержащим использованный объём, квоту и размер файла;
   `File` не создаётся, ссылка не выдаётся.

2. **Потребление считается достоверно.**
   Given файлы, все их версии и объекты в корзине;
   When считается потребление;
   Then учитываются `FileVersion.sizeBytes` всех неудалённых физически версий (включая корзину);
   значение поддерживается инкрементально (счётчик в `Organization` обновляется в той же
   транзакции, что и commit/удаление) и сверяется ночным джобом с фактом в хранилище.

3. **Лимит размера отдельного файла.**
   Given `MAX_FILE_SIZE_BYTES` (дефолт 100 МБ) и отдельный лимит для изображений/аватаров;
   When заявлен файл больше лимита;
   Then 413 до выдачи ссылки; подпись PUT в любом случае содержит `content-length-range`, поэтому
   обход через клиент невозможен (`T-FILE-03`).

4. **Whitelist MIME.**
   Given список разрешённых типов (по скоупу: аватары — только `image/png|jpeg|webp`; общие файлы —
   документы, архивы, изображения, текст);
   When заявлен тип вне whitelist;
   Then 415 `unsupported_media_type` до загрузки; проверка повторяется на commit по фактическому
   `HeadObject` — заявленный тип не является доверенным.

5. **Негативный сценарий — подмена расширения.**
   Given исполняемый файл, переименованный в `.png`;
   When выполняется commit;
   Then фактический `content-type` из `HeadObject` не совпадает с whitelist → 415, объект удаляется
   из хранилища.

6. **Негативный сценарий — исчерпание квоты в процессе.**
   Given две параллельные загрузки, каждая из которых по отдельности умещается в остаток квоты;
   When обе коммитятся;
   Then счётчик обновляется атомарно (`UPDATE ... SET used_bytes = used_bytes + $1 WHERE used_bytes
   + $1 <= quota RETURNING`), вторая получает 413, объект удаляется; тест конкурентности обязателен.

7. **Предупреждение до отказа.**
   Given потребление ≥ 80 % квоты;
   When администратор с `file:view_quota` открывает раздел хранилища;
   Then виден баннер с процентом заполнения и разбивкой по скоупам; при 100 % — явное объяснение,
   что именно блокируется; метрика `storage_quota_ratio` под алертом (`T-FILE-08`).

8. **Негативный сценарий — нет права на квоты.**
   Given пользователь без `file:view_quota`;
   When он запрашивает раздел;
   Then 403 `permission_not_granted`; сама ошибка превышения квоты при этом остаётся понятной всем
   («хранилище организации заполнено, обратитесь к администратору»).

9. **Изменение квоты.**
   Given владелец с `organization:manage_storage` (`dangerous`);
   When он меняет квоту;
   Then значение сохраняется, событие пишется в `AuditLog` с before/after; понижение квоты ниже
   текущего потребления допускается, но блокирует новые загрузки и явно об этом предупреждает.

10. **Rate limiting загрузок.**
    Given один пользователь;
    When он запрашивает больше 60 presign в минуту;
    Then 429 с `Retry-After`; метрика растёт (защита от раздувания `pending`-записей).

11. **UI показывает ограничения заранее.**
    Given компонент загрузки;
    When пользователь выбирает файл;
    Then недопустимый тип или размер отклоняются на клиенте **до** сетевого запроса с inline-текстом
    (не тост), а сервер остаётся авторитетом; сообщения локализованы EN/RU.

## Задачи

- [ ] `packages/server/prisma/migrations/*_storage_quota/migration.sql` — `organizations.storage_quota_bytes`,
      `organizations.storage_used_bytes` + CHECK `>= 0`.
- [ ] `packages/shared/src/file/mime-whitelist.ts`, `file-limits.ts` — общие для клиента и сервера
      (источник правды один).
- [ ] `packages/server/src/domain/file/quota.ts` — чистые функции проверки квоты и лимитов.
- [ ] `packages/server/src/application/file/use-cases/reserve-quota.use-case.ts` (атомарный
      инкремент), `release-quota.use-case.ts`.
- [ ] `packages/server/src/application/file/queries/get-storage-usage.query.ts` — разбивка по
      скоупам и проектам.
- [ ] `packages/server/src/application/platform/jobs/reconcile-storage-usage.job.ts` — ночная
      сверка счётчика с фактом в хранилище + метрика расхождения.
- [ ] `packages/server/src/infrastructure/rate-limit/file-presign.limiter.ts`.
- [ ] `packages/server/src/presentation/http/routes/registry.ts` — `file:view_quota`,
      `organization:manage_storage`.
- [ ] `packages/client/src/widgets/storage-usage/storage-usage.widget.tsx` +
      `ui/quota-bar.component.tsx`; валидация в `use-file-upload.hook.ts` по общим лимитам.
- [ ] Тесты: `quota.spec.ts` (табличный), конкурентный `quota-race.spec.ts` (п. 6),
      интеграционные `mime-whitelist.spec.ts` (п. 4, 5), `quota-exceeded.spec.ts` (п. 1),
      `reconcile-storage-usage.job.spec.ts`, компонентный на п. 11.

## Ссылки

- [`threat-model.md`, `T-FILE-08` («квота организации; джоб зачистки; алерт при заполнении тома»),
  `T-FILE-03`, `T-FILE-05`](../../../docs/security/threat-model.md)
- [`permission-model.md` §3.8 (`file:view_quota`), §3.1 (`organization:manage_storage` — `dangerous`)](../../../docs/security/permission-model.md)
- [`data-model.md`, группа 6, `sizeBytes`, `checksumSha256`](../../../docs/architecture/data-model.md)
- [`ux-architecture.md`, «Формы», «Одно действие — ровно один сигнал»](../../../docs/architecture/ux-architecture.md)

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
