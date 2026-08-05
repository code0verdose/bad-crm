---
id: STORY-016-02
epic: EPIC-016
status: in-progress
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

## Что уже сделано (2026-08-05)

- [x] Хранилище порта: `infrastructure/persistence/prisma/audit-log.adapter.ts` пишет строку **в ту
      же транзакцию**, что и изменение (транзакция берётся из `withTenant` через
      AsyncLocalStorage — так же, как её берут репозитории). Откат изменения откатывает и запись;
      доказано тестом `test/integration/db/audit-trail-writes.test.ts` с положительным контролем
      (та же запись при успешной транзакции остаётся).
- [x] `severity` определяется **действием**, а не местом вызова: `AUDIT_ACTION_SEVERITY` в
      `packages/shared/src/audit` (`Record<AuditAction, …>` — действие без уровня не компилируется).
      Иначе одно и то же событие попадает в журнал под двумя уровнями и фильтр «покажи critical»
      молча неполон.
- [x] Адрес не хранится: в `ip_hash` идёт ключевой хеш (тот же, что у сессий), `request_id`
      берётся из окружения запроса, когда use-case его не передал.
- [x] События, которые **не могут** быть строкой, по-прежнему идут в лог: `organization_id` —
      `NOT NULL`, а часть привилегированных действий происходит до того, как организация известна
      (отклонённый вход, обслуживание из скрипта). Отдельно отвергается запись, чей
      `organizationId` не совпадает со скоупом: положить её под скоуп значило бы записать событие
      организации B в журнал организации A.

Остальное из acceptance 2 — список обязательных событий — по построению не может быть закрыто
сейчас: `role.*`, `permission.override.*`, `acl.*`, `file.*`, `user.mfa_*` называют домены, которых
ещё нет. Каждый из них добавляет своё действие в `AUDIT_ACTIONS` вместе с собой, а `audit-coverage`
как отдельный гейт имеет смысл, когда список перестанет расти каждую историю (фаза 2 эпика).

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
