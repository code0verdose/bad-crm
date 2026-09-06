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

- [x] `packages/shared/src/organization/security-policy.schema.ts` — Zod-схема
      (`mfaRequiredForRoles: SystemRoleKey[] ∪ customRoleIds`, `mfaGracePeriodDays: 0…30`), тип через
      `z.infer`; чтение `Organization.settings` через `safeParse`. Добавлено третье поле, которого в
      исходном списке не было и без которого критерий 5 невыразим: `mfaRequiredSince` —
      дата **на роль**, вторая половина отсчёта рядом с `UserRole.grantedAt`.
- [x] `packages/server/src/application/organization/use-cases/update-security-policy.use-case.ts`.
- [x] `mfa-coverage-report.query.ts` (п. 2, 9) — в `use-cases/`, а не в `queries/`: правило имён
      требует `.query.ts` внутри `use-cases/`, каталога `queries/` в этом пакете нет.
- [x] `packages/server/src/domain/identity/access/mfa-requirement.policy.ts` — чистая
      `evaluateMfaRequirement`. Суффикс `.policy.ts` обязателен (`naming.test.ts`), и функция
      возвращает `graceEndsAtMs: number`, а не `Date`: `new Date(...)` в `domain` запрещён
      `layers.test.ts`, потому что тот же конструктор строит и момент из аргумента, и момент из
      часов. Вердикт шире, чем `{ required, graceEndsAt }` — `not_covered | satisfied | grace |
      enrollment_required`, чтобы отчёт покрытия и гейт входа читали один ответ.
- [x] `scope = mfa_enrollment` — **не отдельный сервис токенов**. Это claim обычного access-токена
      (`jwt-access-token.adapter.ts`), а не второй вид токена: в отличие от `mfa_pending`, эта
      сессия настоящая — строка есть, вызывающий установлен, — и отличается только тем, куда её
      пускают. Отдельный issuer заставил бы `authenticate.middleware.ts` проверять сессию дважды.
      Любое **иное** значение `scope` отвергается, а не читается как «без области».
- [x] `packages/server/src/presentation/http/route-registry.factory.ts` —
      `organization:manage_security_policy` (ключ уже был в закрытом каталоге, `dangerous: true`,
      у `owner` и `admin` — миграции каталога не потребовалось); whitelist через
      `mfaEnrollmentAllowed?: true` в объявлении маршрута, гейт монтируется по производному
      предикату `requiresFullSession`, поэтому «забыл написать» означает «закрыто».
- [ ] **Клиентская половина — не сделана, вне зоны этой дельты.** Контракт под неё отгружен целиком:
      `GET`/`PATCH /organization/security-policy` и `GET /organization/mfa-coverage` (последняя
      принимает `?role=&graceDays=` и отвечает предпросмотром **несохранённого** черновика —
      критерий 2 — тем же кодом, что и постоянный отчёт), `mfaEnrollment` и `mfaGraceEndsAt` в
      ответе входа под баннер критерия 4, коды `mfa_enrollment_required` и `mfa_required_by_policy`
      переведены на оба языка.
- [ ] `packages/client/src/app/routes/_authenticated/admin/organization.tsx` — вкладка `security`;
      `widgets/security-policy/security-policy.widget.tsx` +
      `ui/mfa-coverage-table.component.tsx`, `ui/policy-preview-modal.component.tsx`.
- [ ] `packages/client/src/app/routes/_authenticated.tsx` — редирект на мастер настройки при
      `mfa_enrollment`; `widgets/mfa-enrollment-gate/mfa-enrollment-gate.widget.tsx`, баннер
      grace-периода.
- [ ] i18n: `packages/client/src/app/i18n/{en,ru}/security-policy.json`.
- [x] Тесты: `test/unit/domain/mfa-requirement.test.ts` (табличный: роль × политика × grace ×
      наличие 2FA), `test/unit/http/mfa-enrollment-scope.test.ts` (табличный по `ROUTE_REGISTRY`,
      п. 3 — три таблицы: отказ, положительный контроль обычным токеном, и сам whitelist как
      множество; снятие гейта делает красными 41 из 86 кейсов),
      `test/integration/http/security-policy.test.ts` (п. 1, 2, 3, 4, 5, 7, 8, 9, 10, 11),
      блок «the organization policy» в `test/unit/application/disable-totp.use-case.test.ts` (п. 6).
- [ ] e2e `mandatory-2fa-enrollment.spec.ts` + axe — вместе с клиентской половиной: сценарий
      целиком экранный.

## Что сделано и что осталось (серверная половина, 2026-09-06)

**Закрыто на сервере:** 1 (хранение + аудит `organization.security_policy_updated`, `CRITICAL`,
before/after), 3 (область токена и табличная проверка по реестру), 4 (льготный период), 5 (отсчёт
следует за ролью в обе стороны), 6 (409 `mfa_required_by_policy` в `DisableTotpUseCase`), 7
(428 `confirmation_required` и повтор с `confirmedSelfLockout`), 8 (403 без права), 10 (дефолт —
выключено), 11 (изоляция), серверные половины 2 и 9 (отчёт покрытия, включая предпросмотр
черновика).

**Осталось:** экранные половины 2, 4 и 9 (вкладка настроек, баннер обратного отсчёта, таблица
покрытия с фильтрами в URL и напоминаниями), гард `beforeLoad` для вкладки (критерий 8, вторая
половина) и e2e. Напоминание сотруднику из критерия 9 сервером **не** реализовано — ручки под него
нет, и заглушки не заведено.

**Про самоблокировку владельца — прямо.** Владелец, включивший политику на собственную роль без
второго фактора, из продукта не выпадает: подписанная область оставляет ему ровно те маршруты,
которыми второй фактор и настраивается, а пароль не менялся, так что войти он может всегда. Тупика
эта операция не создаёт. Тупик существует **другой** и создаётся не здесь: аккаунт, у которого 2FA
уже включена, аутентификатор потерян, коды восстановления израсходованы, а в организации больше
никого с `user:reset_mfa`. Выход из него — операторский, по
[`docs/runbooks/incident.md`](../../../docs/runbooks/incident.md), и он не появился с этой историей.

**Про стоимость.** Проверка политики **не добавляет ни одного чтения на запрос**. Она выполняется
там, где выдаётся сессия (`IssueSessionUseCase`), то есть при входе и при каждом обновлении токена —
раз в пятнадцать минут на сессию, — и стоит три оператора: `settings` корня арендатора, неистёкшие
назначения ролей субъекта, строка записи TOTP. Вердикт едет в claim `scope`, поэтому гейт на
маршруте не читает ничего. Альтернатива — решать в мидлваре — положила бы эти три оператора на
**каждый** запрос **каждой** организации, включая те, где политики нет вовсе, то есть по умолчанию
все. Сравнение с STORY-011-08: сборка прав — одиннадцать операторов и 5,4 мс на запрос; эта дельта
к тому числу не прибавляет ничего.

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
