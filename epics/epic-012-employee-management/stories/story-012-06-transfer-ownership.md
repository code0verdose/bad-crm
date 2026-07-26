---
id: STORY-012-06
epic: EPIC-012
status: backlog
blocked: false
priority: must
estimate: S
---

# STORY-012-06 — Передача владения организацией

**Как** владелец инсталляции (P1) **я хочу** передать владение организацией другому сотруднику
явной операцией с подтверждением, **чтобы** уход основателя не оставлял организацию без владельца и
не превращался в правку базы данных руками.

## Acceptance (Given/When/Then)

1. **Успешная передача.**
   Given владелец Анна и активный сотрудник Борис;
   When `POST /api/v1/organization/transfer-ownership` с `{ toUserId: boris, confirmation }`
   (право `organization:transfer_ownership`, только у `owner`);
   Then **в одной транзакции**: Борису назначается системная роль `owner`, `Organization.ownerId`
   обновляется, `permissions_version` инкрементится **обоим**, в `AuditLog` —
   `organization.ownership_transferred` с `{ fromUserId, toUserId }` и `severity = critical`.

2. **Что происходит с прежним владельцем.**
   Given операция выполнена;
   When проверяется состояние Анны;
   Then роль `owner` с неё снята, но выбранная в форме «роль после передачи» (по умолчанию `admin`)
   назначена — организация не остаётся с человеком без доступа; выбор виден в подтверждении.

3. **Организация всегда с владельцем.**
   Given любой момент выполнения операции;
   When транзакция откатывается на любом шаге;
   Then владелец остаётся прежним; инвариант «минимум один активный `owner`» проверяется в конце
   транзакции запросом к `Organization.ownerId` и `UserRole`.

4. **Негативный сценарий — получатель неактивен.**
   Given Борис имеет `status = SUSPENDED` или `INVITED`;
   When выполняется передача;
   Then 409 `recipient_not_active`; ничего не изменено.

5. **Негативный сценарий — получатель без 2FA при обязательной политике.**
   Given в организации включена обязательная 2FA для роли `owner`, у Бориса TOTP не настроен;
   When выполняется передача;
   Then 409 `mfa_required_for_owner` с понятным текстом «получатель должен включить 2FA»
   (стыковка с [EPIC-013](../../epic-013-two-factor-totp/epic.md)).

6. **Негативный сценарий — не владелец.**
   Given администратор с `role:assign`, но без роли `owner`;
   When он вызывает эндпоинт;
   Then 403 `permission_not_granted`: `organization:transfer_ownership` есть только у `owner`
   (§4.1 `permission-model.md`).

7. **Негативный сценарий — передача самому себе.**
   Given `toUserId` совпадает с актором;
   When выполняется операция;
   Then 422 `invalid_recipient`.

8. **Подтверждение в UI.**
   Given экран `/admin/organization?tab=general`;
   When владелец инициирует передачу;
   Then модалка требует ввести `slug` организации и явно перечисляет, что владелец получит все 307
   прав, а инициатор их потеряет; действие пессимистично, тост один.

9. **Кросс-тенантность.**
   Given `toUserId` из организации B;
   When выполняется передача;
   Then **404** `resource_not_found`.

10. **Уведомление.**
    Given передача выполнена;
    When транзакция закоммичена;
    Then обоим участникам уходит уведомление (in-app всегда, email — если SMTP настроен), событие
    публикуется через outbox, доставка идемпотентна.

## Задачи

- [ ] `packages/server/src/application/iam/use-cases/transfer-ownership.use-case.ts` — одна
      транзакция, инкремент версии обоим, запись аудита, outbox-уведомление.
- [ ] `packages/server/src/domain/iam/access/ownership.policy.ts` — `canTransferOwnership`,
      `assertRecipientEligible` (активность, 2FA), `assertNotSelf`.
- [ ] `packages/server/prisma/migrations/*_organization_owner/migration.sql` — колонка
      `organizations.owner_id` с FK и NOT NULL после бэкфила (expand → migrate → contract).
- [ ] `packages/server/src/presentation/http/routes/registry.ts` — `organization:transfer_ownership`.
- [ ] `packages/client/src/widgets/transfer-ownership/transfer-ownership-dialog.widget.tsx` +
      `units/organization/service/mutations/transfer-ownership.mutation.ts`,
      `units/organization/model/validation/transfer-ownership.schema.ts` (подтверждение по `slug`).
- [ ] i18n: `packages/client/src/app/i18n/{en,ru}/organization.json`.
- [ ] Тесты: `ownership.policy.spec.ts` (п. 4–7), интеграционный `transfer-ownership.spec.ts`
      (п. 1–3, 9, 10), тест инварианта «после операции ровно один активный owner»,
      компонентный на подтверждение.

## Ссылки

- [`permission-model.md` §2 «Про owner», §4.1, §4.11 «Снять последнего владельца»](../../../docs/security/permission-model.md)
- [`permission-model.md` §10, событие `organization.ownership_transferred` (`critical`)](../../../docs/security/permission-model.md)
- [`permission-model.md` §12, расхождение №7 (`Organization.ownerId`)](../../../docs/security/permission-model.md)
- [`data-model.md`, «Стратегия миграций: expand → migrate → contract»](../../../docs/architecture/data-model.md)
- [`ux-architecture.md`, `/admin/organization`, «Подтверждение разрушающих действий»](../../../docs/architecture/ux-architecture.md)

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
