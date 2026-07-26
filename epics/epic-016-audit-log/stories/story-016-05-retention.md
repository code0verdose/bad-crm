---
id: STORY-016-05
epic: EPIC-016
status: backlog
blocked: false
priority: should
estimate: M
---

# STORY-016-05 — Ретенция и архивация

**Как** владелец инсталляции (P1) **я хочу** задавать срок хранения журнала и знать, что старые
записи архивируются предсказуемой процедурой, **чтобы** база не росла бесконечно, но и не теряла
данные, которые могут понадобиться на аудите через год.

## Acceptance (Given/When/Then)

1. **Настройка срока хранения.**
   Given владелец с правом `audit:manage_retention` (**только `owner`**, `dangerous`);
   When `PATCH /api/v1/organization/audit-retention` с `{ retentionMonths: 24 }`;
   Then значение сохраняется, минимально допустимое (например 12 месяцев) валидируется Zod,
   изменение пишется в `AuditLog` с `severity = critical` и before/after.

2. **Негативный сценарий — нет права.**
   Given администратор с `audit:read_security`, но без `audit:manage_retention`;
   When он меняет срок;
   Then 403 `permission_not_granted` — снижение ретенции равносильно уничтожению улик и доступно
   только владельцу (§4.10 `permission-model.md`).

3. **Архивация выполняется `app_migrator`, а не приложением.**
   Given партиция старше срока хранения;
   When выполняется процедура ретенции;
   Then она запускается отдельной операцией под ролью `app_migrator`: `DETACH PARTITION` →
   выгрузка в архив (сжатый дамп в объектное хранилище или на диск) → `DROP`; приложение под
   `app_user` не может выполнить ни одну из этих команд (структурный тест).

4. **`DELETE` на миллионах строк запрещён.**
   Given реализация ретенции;
   When она ревьюится и тестируется;
   Then в коде нет `DELETE FROM audit_logs` — только операции с партициями; наличие такого запроса
   ломает тест и вердикт агента `db-reviewer`.

5. **Ретенция уважает разные сроки у организаций.**
   Given мультиарендная инсталляция с разными `retentionMonths`;
   When партиция содержит строки нескольких организаций;
   Then партиция отцепляется только когда её период старше **максимального** срока среди
   организаций; для организаций с меньшим сроком применяется маскирование доступа (журнал перестаёт
   отдаваться в UI за пределами их срока) — компромисс явно задокументирован, потому что физическое
   удаление по одной организации из общей партиции невозможно.

6. **Архив восстановим.**
   Given заархивированная партиция;
   When выполняется процедура восстановления из runbook;
   Then данные возвращаются в отдельную таблицу и доступны для чтения; процедура проверяется на
   копии данных перед мажорным релизом (аналог требования NFR-5 для бэкапов).

7. **Негативный сценарий — потеря архива.**
   Given архивация завершилась ошибкой загрузки в хранилище;
   When процедура доходит до `DROP PARTITION`;
   Then удаление **не выполняется**: fail-closed, метрика `audit_retention_failed_total`, алерт;
   партиция остаётся отцепленной, но живой до успешной архивации.

8. **Наблюдаемость.**
   Given процедура ретенции;
   When она отрабатывает;
   Then экспортируются метрики: число обработанных партиций, объём архива, длительность; событие
   `audit.retention_applied` пишется с `actorType = SYSTEM`.

9. **Runbook.**
   Given `docs/runbooks/audit-log.md`;
   When администратор его читает;
   Then описаны: как выполняется ретенция, под какой ролью, где лежит архив, как восстановить, что
   делать при сбое, какова оценка роста объёма.

10. **UI.**
    Given экран `/admin/organization?tab=security`;
    When владелец меняет срок;
    Then показано предупреждение о необратимости для более старых данных, требуется подтверждение;
    видна дата, до которой журнал фактически доступен; экран локализован EN/RU и проходит axe.

## Задачи

- [ ] `packages/server/prisma/migrations/*_audit_retention/migration.sql` —
      `organizations.audit_retention_months` + CHECK (минимум 12).
- [ ] `packages/server/src/application/platform/use-cases/update-audit-retention.use-case.ts`.
- [ ] `packages/server/scripts/audit-retention.ts` — операция под `app_migrator`
      (`DETACH` → архивация → `DROP`), запускается отдельным job'ом деплоя/крона, а не рантаймом
      приложения.
- [ ] `packages/server/src/infrastructure/archive/audit-archive.adapter.ts` — выгрузка отцепленной
      партиции (сжатие + запись в объектное хранилище с шифрованием на стороне скрипта).
- [ ] `packages/server/src/presentation/http/routes/registry.ts` — `audit:manage_retention`.
- [ ] `packages/client/src/widgets/security-policy/ui/audit-retention-field.component.tsx`,
      `units/audit/service/mutations/update-audit-retention.mutation.ts`.
- [ ] `docs/runbooks/audit-log.md` — раздел «Ретенция и восстановление архива».
- [ ] Тесты: `update-audit-retention.use-case.spec.ts` (п. 1, 2), структурный
      `app-user-cannot-detach-partition.spec.ts` (п. 3), `no-delete-on-audit-logs.spec.ts` (п. 4),
      интеграционный `audit-retention-script.spec.ts` (п. 6, 7 — на Testcontainers).

## Ссылки

- [`data-model.md`, группа 14 («Удаление старых партиций по политике хранения — прерогатива
  `app_migrator`»)](../../../docs/architecture/data-model.md)
- [`rls-design.md`, «Партиционированные таблицы (`audit_logs`)», роли БД](../../../docs/security/rls-design.md)
- [`permission-model.md` §10 «Кто может смотреть» (`audit:manage_retention` — только `owner`), §4.10](../../../docs/security/permission-model.md)
- [`threat-model.md`, `T-PLAT-05`, `T-SH-05` (бэкапы без шифрования)](../../../docs/security/threat-model.md)
- [`prd.md`, NFR-5 (RPO/RTO, «бэкап без проверки восстановления не считается бэкапом»)](../../../docs/product/prd.md)

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
