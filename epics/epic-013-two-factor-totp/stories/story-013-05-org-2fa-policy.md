---
id: STORY-013-05
epic: EPIC-013
status: backlog
blocked: false
priority: must
estimate: M
---

# STORY-013-05 — Политика организации «2FA обязательна»

**Как** владелец инсталляции (P1) **я хочу** включить требование второго фактора для выбранных ролей
и увидеть, кого это затронет, **чтобы** пройти security-опросник заказчика ответом «2FA обязательна
для администраторов и менеджеров», а не «мы всех попросили».

## Acceptance (Given/When/Then)

1. **Включение политики.**
   Given владелец с `organization:manage_security_policy` (`dangerous`);
   When `PATCH /api/v1/organization/security-policy` с
   `{ mfaRequiredForRoles: ['owner','admin','manager'], mfaGracePeriodDays: 7 }`;
   Then настройка сохраняется в `Organization.settings` (валидируется Zod при чтении и записи), в
   `AuditLog` — `organization.security_policy_updated` (`severity = critical`) с before/after.

2. **Предпросмотр «кого затронет».**
   Given черновик политики;
   When открывается подтверждение;
   Then показан отчёт покрытия: сколько людей с этими ролями уже имеют 2FA, сколько нет, поимённый
   список последних; применение требует явного подтверждения.

3. **Принудительная настройка при следующем входе.**
   Given политика включена, у пользователя роли `admin` и 2FA не настроена, grace-период истёк;
   When он успешно вводит пароль;
   Then выдаётся токен со `scope = mfa_enrollment` (тот же принцип, что и `mfa_pending`): доступны
   **только** маршруты настройки TOTP и выхода; любой другой маршрут отвечает 403
   `mfa_enrollment_required` — проверяется табличным тестом по `ROUTE_REGISTRY`.

4. **Grace-период.**
   Given `mfaGracePeriodDays = 7` и политика включена сегодня;
   When пользователь без 2FA входит на 3-й день;
   Then он работает нормально, но видит несбрасываемый баннер с обратным отсчётом; на 8-й день
   срабатывает п. 3.

5. **Политика следует за ролью.**
   Given пользователь без 2FA получает роль `manager`, входящую в политику;
   When он делает следующий запрос;
   Then для него включается grace-период с момента назначения роли, а не с момента включения
   политики; при снятии роли требование пропадает.

6. **Негативный сценарий — отключение 2FA под политикой.**
   Given пользователь под действием политики;
   When он вызывает `2fa/disable`;
   Then 409 `mfa_required_by_policy` (см. [STORY-013-04](story-013-04-disable-totp.md)).

7. **Негативный сценарий — владелец без 2FA не может включить политику для себя вслепую.**
   Given владелец без настроенной 2FA включает политику, включающую роль `owner`;
   When он подтверждает;
   Then предупреждение «вы сами попадёте под требование и при следующем входе будете обязаны
   настроить 2FA»; операция разрешена, но требует ввода второго подтверждения — это предотвращает
   случайную самоблокировку организации.

8. **Негативный сценарий — нет права.**
   Given администратор без `organization:manage_security_policy`;
   When он меняет политику;
   Then 403 `permission_not_granted`; вкладка `/admin/organization?tab=security` недоступна
   (гард `beforeLoad`).

9. **Отчёт покрытия.**
   Given политика действует;
   When администратор открывает вкладку безопасности;
   Then виден список сотрудников без 2FA с фильтром по роли и статусу (состояние в URL) и
   возможность отправить напоминание (in-app всегда, email при настроенном SMTP).

10. **Дефолт self-host.**
    Given чистая инсталляция;
    When она поднимается;
    Then политика **выключена** по умолчанию, но пункт 7 чек-листа установки и мастер первичной
    настройки явно предлагают её включить (стыковка с
    [EPIC-017](../../epic-017-self-host-alpha/epic.md)).

11. **Кросс-тенантность.**
    Given политика организации A;
    When пользователь организации B проверяется на требование;
    Then применяются только настройки собственной организации; isolation-тест это подтверждает.

## Задачи

- [ ] `packages/shared/src/organization/security-policy.schema.ts` — Zod-схема
      (`mfaRequiredForRoles: SystemRoleKey[] ∪ customRoleIds`, `mfaGracePeriodDays: 0…30`), тип через
      `z.infer`; чтение `Organization.settings` через `safeParse`.
- [ ] `packages/server/src/application/organization/use-cases/update-security-policy.use-case.ts`.
- [ ] `packages/server/src/application/organization/queries/mfa-coverage-report.query.ts` (п. 2, 9).
- [ ] `packages/server/src/domain/auth/access/mfa-requirement.ts` — чистая функция
      `isMfaRequired(actorRoles, policy, roleGrantedAt, now): { required, graceEndsAt }`.
- [ ] `packages/server/src/infrastructure/auth/mfa-enrollment-token.service.ts` +
      обработка `scope = mfa_enrollment` в `auth.middleware.ts`.
- [ ] `packages/server/src/presentation/http/routes/registry.ts` —
      `organization:manage_security_policy`; whitelist маршрутов, доступных при `mfa_enrollment`.
- [ ] `packages/client/src/app/routes/_authenticated/admin/organization.tsx` — вкладка `security`;
      `widgets/security-policy/security-policy.widget.tsx` +
      `ui/mfa-coverage-table.component.tsx`, `ui/policy-preview-modal.component.tsx`.
- [ ] `packages/client/src/app/routes/_authenticated.tsx` — редирект на мастер настройки при
      `mfa_enrollment`; `widgets/mfa-enrollment-gate/mfa-enrollment-gate.widget.tsx`, баннер
      grace-периода.
- [ ] i18n: `packages/client/src/app/i18n/{en,ru}/security-policy.json`.
- [ ] Тесты: `mfa-requirement.spec.ts` (табличный: роль × политика × grace × наличие 2FA),
      `mfa-enrollment-token-scope.spec.ts` (табличный по `ROUTE_REGISTRY`, п. 3),
      интеграционные п. 5, 6, 8, e2e `mandatory-2fa-enrollment.spec.ts` + axe.

## Ссылки

- [`prd.md`, NFR-6 («обязательная возможность включить 2FA на уровне организации»)](../../../docs/product/prd.md)
- [`threat-model.md`, чек-лист безопасной установки п. 7, `T-IAM-04`](../../../docs/security/threat-model.md)
- [`permission-model.md` §3.1 (`organization:manage_security_policy`), §4.1](../../../docs/security/permission-model.md)
- [`data-model.md`, группа 1, `Organization.settings Json`](../../../docs/architecture/data-model.md)
- [`ux-architecture.md`, `/admin/organization` (`tab=security`), «Гарды в beforeLoad»](../../../docs/architecture/ux-architecture.md)

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
