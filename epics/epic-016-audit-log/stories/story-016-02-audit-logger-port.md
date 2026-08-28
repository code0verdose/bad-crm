---
id: STORY-016-02
epic: EPIC-016
status: backlog
blocked: false
priority: must
estimate: L
---

# STORY-016-02 — AuditLoggerPort и запись событий из use-cases

**Как** администратор системы (P5) **я хочу**, чтобы каждое привилегированное действие оставляло
запись с актором, объектом, состоянием до и после и идентификатором запроса, **чтобы** на вопрос
«кто это сделал и что было раньше» отвечал журнал, а не реконструкция по косвенным признакам.

## Acceptance (Given/When/Then)

1. **Порт и запись в той же транзакции.**
   Given `AuditLoggerPort.record(event)` и use-case, меняющий состояние;
   When изменение выполняется;
   Then запись аудита пишется **в той же транзакции**; откат транзакции откатывает и запись, а
   падение после коммита не теряет событие (тест на оба сценария).

2. **Обязательный список событий покрыт.**
   Given реализованные к моменту истории домены;
   When проверяется `audit-coverage.spec.ts`;
   Then для каждого из перечисленных ниже действий существует запись с корректными `action`,
   `resourceType`, `severity`:
   - **права и роли:** `role.created/updated/deleted`, `role.assigned/revoked`,
     `permission.override.created/updated/deleted/expired`, `acl.granted/updated/revoked`,
     `permissions.recomputed`;
   - **владение и организация:** `organization.ownership_transferred` (`critical`),
     `organization.security_policy_updated`, `organization.settings_updated`;
   - **учётные записи:** `user.invited/accepted/suspended/reactivated`, `user.mfa_enabled/disabled`,
     `user.mfa_reset_by_admin` (`critical`), `user.mfa_recovery_code_used`,
     `user.impersonation_started/ended` (`critical`), `user.login`, `user.logout`,
     `session.revoked`, `session.refresh_reuse_detected` (`critical`);
   - **файлы:** `file.upload_presigned`, `file.committed`, `file.download_url_issued`,
     `file.deleted/restored/purged`, `file.acl_changed`;
   - **экспорт данных:** `audit.exported` (`critical`), `organization.data_exported` (`critical`),
     `report.exported`;
   - **секреты (задел под M7):** события домена vault и секретных ссылок регистрируются тем же
     портом, когда домены появятся.

3. **Наборы прав пишутся целиком.**
   Given изменение состава прав роли;
   When пишется событие;
   Then `before`/`after` содержат **полный** список ключей до и после, а не дельту; `reason`
   оверрайда обязателен и присутствует в `after`.

4. **Актор всегда известен.**
   Given действие пользователя, воркера или интеграции;
   When пишется событие;
   Then `actorType` заполнен (`USER | SYSTEM | API_KEY | INTEGRATION`), для системных действий
   `actorId = null`; `requestId` протянут сквозь HTTP → outbox → job → аудит (тест сквозного
   `requestId`, `T-PLAT-09`).

5. **Негативный сценарий — секреты в журнале.**
   Given событие с полями, содержащими пароль, токен, ключ, `totpSecretEnc`, presigned URL,
   расшифрованное содержимое;
   When оно записывается;
   Then эти поля отсутствуют: `before`/`after` строятся по **whitelist** полей на каждый тип
   события; тест `audit-redaction-corpus.spec.ts` прогоняет набор payload'ов и проверяет отсутствие
   паттернов секретов (`T-PLAT-06`).

6. **Негативный сценарий — актор из тела запроса.**
   Given тело запроса содержит `actorId`;
   When пишется событие;
   Then поле игнорируется: актор берётся из `AsyncLocalStorage`-контекста сессии (`T-TASK-04`).

7. **Отказы логируются выборочно.**
   Given отказы в доступе;
   When они происходят;
   Then пишутся: отказ по праву с `isDangerous` — всегда; отказ на изменяющем запросе
   (`POST/PATCH/DELETE`) — всегда; серия > 10 отказов за минуту от одного актора — одной
   агрегированной записью; отказы на `GET` — **только метрика** `permission_denied_total{reason}`.

8. **IP хешируется.**
   Given запись события;
   When сохраняется адрес;
   Then в колонке `ip_hash` — соль + хеш, а не сырой адрес; соль не попадает в дампы вместе с
   данными (ключ в env).

9. **Негативный сценарий — сбой записи аудита.**
   Given ошибка вставки в `audit_logs` для события безопасности;
   When она происходит;
   Then транзакция откатывается целиком — операция не считается выполненной (fail-closed для
   `severity ∈ {warning, critical}`); для `info`-событий допускается деградация с метрикой
   `audit_write_failed_total` и алертом.

10. **Производительность.**
    Given изменяющий запрос;
    When он выполняется;
    Then аудит добавляет одну вставку и не выполняет дополнительных чтений внутри транзакции;
    накладные расходы измерены и зафиксированы в нагрузочном сценарии.

## Задачи

- [ ] `packages/server/src/application/platform/ports/audit-logger.port.ts` +
      `packages/shared/src/audit/audit-event.types.ts` (типизированный union `action` →
      обязательные поля `before`/`after`).
- [ ] `packages/server/src/infrastructure/persistence/prisma/audit-logger.adapter.ts` — вставка в
      текущей транзакции (`UnitOfWorkPort`).
- [ ] `packages/server/src/application/platform/audit/audit-field-whitelist.ts` — whitelist полей на
      каждый тип события.
- [ ] `packages/server/src/infrastructure/security/ip-hash.util.ts`.
- [ ] Подключение `AuditLoggerPort` во все существующие use-cases EPIC-011/012/013/014/015.
- [ ] `packages/server/src/presentation/http/middleware/request-id.middleware.ts` — протяжка
      `requestId` в контекст и в конверт outbox-события.
- [ ] `packages/server/src/application/access/services/denied-access-audit.service.ts` — правила
      п. 7 (включая агрегацию серий).
- [ ] Тесты: `audit-logger.adapter.spec.ts` (п. 1, 9), `audit-coverage.spec.ts` (п. 2 — табличный
      по списку событий), `audit-redaction-corpus.spec.ts` (п. 5), `request-id-propagation.spec.ts`
      (п. 4), `denied-access-audit.service.spec.ts` (п. 7).

## Что уже сделано — и **не этой историей**

Раздел переписан после сверки с кодом. Прежняя редакция создавала впечатление, что история наполовину
отгружена; это не так. Всё перечисленное ниже приехало с **другими** историями попутно, потому что
привилегированное действие дешевле записать в тот же коммит, что и само действие, чем искать его
потом в выросшей кодовой базе. Собственный вклад 016-02 — whitelist полей, аудит отказов, метрики,
сквозной `requestId` через outbox, замер накладных расходов — не сделан ни в какой части.

Кто что отгрузил:

- [x] **Порт и pino-адаптер — STORY-009-06.** `application/platform/ports/audit-logger.port.ts` и
      `infrastructure/logging/pino-audit.adapter.ts` появились коммитом `0b32d0a`
      («feat(audit): open the trail with sign-in inside it») вместе с первым вызовом. Проверяется
      `git log --oneline -- packages/server/src/application/platform/ports/audit-logger.port.ts`.
- [x] **Таблица, партиции и append-only — STORY-016-01** (`status: review`): миграция
      `prisma/migrations/20260805110000_audit_logs`, тесты
      `test/unit/audit/audit-partitions.test.ts` и `test/integration/db/audit-log-append-only.test.ts`.
- [x] **Запись в той же транзакции — STORY-016-01** (коммит `7070c25`):
      `infrastructure/persistence/prisma/audit-log.adapter.ts` берёт транзакцию из `withTenant` через
      AsyncLocalStorage, как её берут репозитории. Откат изменения откатывает и запись; доказано
      `test/integration/db/audit-trail-writes.test.ts` с положительным контролем.
- [x] **`severity` от действия, а не от места вызова:** `AUDIT_ACTION_SEVERITY` в
      `packages/shared/src/audit` (`Record<AuditAction, …>` — действие без уровня не компилируется).
- [x] **Адрес не хранится:** в `ip_hash` идёт ключевой хеш (`infrastructure/crypto/address-hasher.adapter.ts`,
      тот же, что у сессий); `request_id` адаптер берёт из `RequestContextPort`, когда use-case его
      не передал.
- [x] **События, которые не могут быть строкой, идут в лог:** `organization_id` — `NOT NULL`, а часть
      привилегированных действий происходит до того, как организация известна. Отдельно отвергается
      запись, чей `organizationId` не совпадает со скоупом: положить её под скоуп значило бы записать
      событие организации B в журнал организации A.
- [x] **Вызовы `audit.record` в use-cases** принесли доменные эпики (011, 012, 013) — каждый со своим
      действием, а не эта история. Список файлов печатает
      `grep -rl 'audit\.record(' packages/server/src/application`.
- [x] **Гейт покрытия `audit-coverage` существует и работает** —
      `packages/server/test/unit/audit/audit-coverage.test.ts`. Он читает исходники, проверяет обе
      стороны (действие каталога без вызывающего **и** имя, выдуманное на месте вызова) и имеет
      CONTROL-кейс на непустоту скана. Утверждение прежней редакции, что такой гейт «имеет смысл,
      когда список перестанет расти», устарело.

Про acceptance 2 прежняя редакция была неверна фактически: из названных там семейств `role.*`,
`permission.override.*` и `user.mfa_*` **отгружены** и имеют вызывающего — все три в
`packages/shared/src/audit/audit-action.enums.ts`. Открыты только `acl.*` (домена ресурсного ACL нет,
STORY-011-06 заблокирована до EPIC-014) и `file.*` (EPIC-015).

## Что реально открыто

1. **Whitelist полей (acceptance 5) не построен.** Файла
   `application/platform/audit/audit-field-whitelist.ts` не существует, корпус-теста
   `audit-redaction-corpus.spec.ts` нет. Сегодня отсутствие секретов в `before`/`after` держится
   дисциплиной вызывающего и комментарием в `audit-logger.port.ts` — то есть свойством, которое
   ничто не проверяет. `test/unit/logging/redaction.test.ts` покрывает **логи**, а не аудит:
   `REDACTED_PATHS` к колонкам `before`/`after` не применяется.
2. **Аудита отказов в доступе (acceptance 7) нет ни в какой части.** Действия отказа в каталоге нет,
   `application/access/services/denied-access-audit.service.ts` не существует, агрегата серий нет
   (планировщика и очереди в продукте тоже нет), метрики `permission_denied_total{reason}` нет —
   `MetricsPort` объявляет три метрики. Это признано в двух местах и не должно открываться заново:
   `docs/security/permission-model.md`, раздел «Чего нет», и комментарий к `permission.inspected` в
   `packages/shared/src/audit/audit-action.enums.ts`.
3. **Разделение по severity при сбое записи (acceptance 9) не сделано.** Сегодня падение вставки
   роняет транзакцию для любого события, включая `INFO`; деградации с метрикой
   `audit_write_failed_total` нет — самой метрики в коде нет
   (`grep -rn audit_write_failed_total packages/server/src` печатает пусто).
4. **Накладные расходы (acceptance 10) не измерены.** Нагрузочного сценария нет; утверждение «одна
   вставка без дополнительных чтений» — про конструкцию адаптера, а не про замер.
5. **`session.refresh_reuse_detected` отсутствует при существующем домене.** Обнаружение повторного
   использования refresh-токена реализовано —
   `application/identity/use-cases/refresh-session.use-case.ts` отзывает семью и пишет
   `logger.warn` с `event: SECURITY_EVENTS.refreshReuseDetected`, — но строки в `AuditLog` нет.
   Это **единственный** пункт списка acceptance 2, чей домен уже отгружен, а действия в каталоге нет;
   всё остальное недостающее ждёт своего домена. Лог ротируется и не защищён
   `REVOKE UPDATE, DELETE` — событие безопасности в нём не заменяет журнал.
6. **Адрес доходит до записи в меньшинстве вызовов.** Остальные передают `ipAddress: undefined`, то
   есть пишут `ip_hash = NULL`, и «тот же адрес снова» по журналу не отвечается. Числа здесь
   намеренно не записаны — печатают команды:

   ```bash
   grep -rc 'audit\.record(' packages/server/src/application --include='*.ts' | awk -F: '{s+=$2} END {print s}'
   grep -rhA8 'audit\.record(' packages/server/src/application | grep -c 'ipAddress: input\.'
   grep -rhA8 'audit\.record(' packages/server/src/application | grep -c 'ipAddress: undefined'
   ```

   Причина отложена осознанно и описана в `application/iam/use-cases/reset-user-mfa.use-case.ts`
   (комментарий про `ipAddress: undefined` в `application/iam/**`) — эта история её закрывает.
7. **Сквозной `requestId` через outbox (acceptance 4) непроверяем в принципе:** outbox в коде нет
   (`find packages/server/src -iname '*outbox*'` печатает пусто). Проверить можно только участок
   HTTP → `RequestContextPort` → аудит; часть про job проверяется, когда появится очередь.

**Расхождение имён в acceptance 2, требующее решения до реализации гейта.** Список критерия называет
`user.login`/`user.logout`, `user.invited`/`user.accepted`; каталог отгрузил их под другими именами —
`session.signed_in`/`session.revoked`, `invitation.created`/`invitation.accepted`. Табличный гейт,
написанный буквально по списку критерия, падал бы на несуществующих именах. Списка также нет:
`permission.override.expired`, `permissions.recomputed`, `organization.security_policy_updated`,
`organization.settings_updated`, `user.impersonation_started/ended`, `audit.exported`,
`organization.data_exported`, `report.exported` — часть из них про домены, которых нет. Сверять
критерий с каталогом — первая задача истории, а не правка по ходу написания теста.

## Ссылки

- [`permission-model.md` §10 «Аудит»: таблица событий, «Что именно кладём в before/after», «Отказы»](../../../docs/security/permission-model.md)
- [`data-model.md`, группа 14, `AuditLog`, `OutboxEvent`](../../../docs/architecture/data-model.md)
- [`threat-model.md`, `T-PLAT-05`, `T-PLAT-06`, `T-PLAT-09`, `T-TASK-04`](../../../docs/security/threat-model.md)
- [`overview.md`, «(в) Транзакционный outbox», «(з) Observability»](../../../docs/architecture/overview.md)
- PRD: NFR-6

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
