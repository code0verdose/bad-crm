---
id: STORY-013-04
epic: EPIC-013
status: backlog
blocked: false
priority: must
estimate: S
---

# STORY-013-04 — Отключение и сброс 2FA

**Как** сотрудник **я хочу** отключить второй фактор осознанно — подтвердив пароль и код, — а при
потере аутентификатора получить сброс от администратора, **чтобы** ни случайный клик, ни украденная
сессия не снимали защиту, но и утеря телефона не оставляла меня без доступа навсегда.

## Acceptance (Given/When/Then)

1. **Самостоятельное отключение.**
   Given пользователь с включённой 2FA;
   When `POST /api/v1/auth/2fa/disable` с `{ password, code }`;
   Then при совпадении обоих факторов: `totpSecretEnc = null`, `totpEnabledAt = null`, **все**
   `mfa_recovery_codes` удаляются в той же транзакции; в `AuditLog` — `user.mfa_disabled`
   (`severity = warning`); пользователю уходит уведомление.

2. **Негативный сценарий — только пароль.**
   Given запрос без `code` (или с неверным);
   When он приходит;
   Then 403 `reauthentication_required`; 2FA остаётся включённой. Код восстановления в качестве
   второго подтверждения допускается и гасится как одноразовый.

3. **Негативный сценарий — украденная сессия.**
   Given атакующий владеет действующим access-токеном, но не знает пароля;
   When он вызывает `disable`;
   Then 403: наличие сессии само по себе недостаточно (защита от `T-IAM-01`).

4. **Негативный сценарий — политика организации требует 2FA.**
   Given обязательная 2FA включена для роли пользователя;
   When он отключает второй фактор;
   Then 409 `mfa_required_by_policy` с текстом «политика организации требует 2FA для вашей роли»;
   отключение возможно только после снятия политики или смены роли.

5. **Административный сброс.**
   Given администратор с правом `user:reset_mfa` (`dangerous`);
   When `POST /api/v1/users/{userId}/reset-mfa` с подтверждением;
   Then 2FA у пользователя снимается, recovery-коды удаляются, **все его сессии отзываются**,
   `permissions_version` инкрементится; в `AuditLog` — `user.mfa_reset_by_admin`
   (`severity = critical`) с актором; владельцу учётки уходит уведомление, которое нельзя отключить
   в настройках.

6. **Негативный сценарий — сброс без права.**
   Given администратор без `user:reset_mfa`;
   When он вызывает эндпоинт;
   Then 403 `permission_not_granted`; кнопка в UI отсутствует.

7. **Негативный сценарий — сброс самому себе.**
   Given администратор вызывает сброс на собственном `userId`;
   When операция выполняется;
   Then 409 `self_lockout`-семантика (`invalid_target`): собственная 2FA снимается только
   самостоятельным путём п. 1 — иначе сброс становится обходом второго фактора.

8. **После сброса — принудительная настройка.**
   Given политика организации требует 2FA и администратор сбросил её пользователю;
   When пользователь входит следующий раз;
   Then он попадает в мастер настройки TOTP и не имеет доступа к остальным маршрутам
   ([STORY-013-05](story-013-05-org-2fa-policy.md)).

9. **Кросс-тенантность.**
   Given `userId` из организации B;
   When администратор организации A вызывает сброс;
   Then **404** `resource_not_found`.

10. **UI-подтверждение.**
    Given экран `/settings/security` и карточка сотрудника в админке;
    When инициируется отключение или сброс;
    Then модалка подтверждения перечисляет последствия (потеря recovery-кодов, отзыв сессий),
    действие пессимистично, тост один, экран проходит axe и локализован EN/RU.

## Задачи

- [ ] `packages/server/src/application/auth/use-cases/disable-totp.use-case.ts`.
- [ ] `packages/server/src/application/iam/use-cases/reset-user-mfa.use-case.ts` — снятие 2FA +
      отзыв сессий + инкремент версии в одной транзакции, уведомление через outbox.
- [ ] `packages/server/src/domain/auth/access/mfa-policy.policy.ts` —
      `assertNotRequiredByPolicy`, `assertNotSelfReset`.
- [ ] `packages/server/src/presentation/http/routes/registry.ts` — `2fa/disable` (self-service),
      `user:reset_mfa`.
- [ ] `packages/client/src/widgets/two-factor-settings/two-factor-settings.widget.tsx` +
      `ui/disable-2fa-dialog.component.tsx`; в админке —
      `widgets/user-security/ui/reset-mfa-dialog.component.tsx` под `<Can permission="user:reset_mfa">`.
- [ ] `packages/client/src/units/auth/service/mutations/disable-totp.mutation.ts`,
      `units/iam/service/mutations/reset-user-mfa.mutation.ts`.
- [ ] Тесты: `disable-totp.use-case.spec.ts` (п. 2–4), `reset-user-mfa.use-case.spec.ts`
      (п. 5–7, 9), интеграционный «после сброса сессии отозваны», e2e + axe.

## Ссылки

- [`threat-model.md`, `T-IAM-04`, `T-IAM-01`, `T-IAM-06`](../../../docs/security/threat-model.md)
- [`permission-model.md` §3.2 (`user:reset_mfa` — `dangerous`), §4.1](../../../docs/security/permission-model.md)
- [`permission-model.md` §10 «Аудит», отказы по опасным правам](../../../docs/security/permission-model.md)
- [`ux-architecture.md`, `/settings/security`, «Подтверждение разрушающих действий»](../../../docs/architecture/ux-architecture.md)

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
