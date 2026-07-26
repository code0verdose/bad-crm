---
id: STORY-013-03
epic: EPIC-013
status: backlog
blocked: false
priority: must
estimate: M
---

# STORY-013-03 — Вход со вторым фактором

**Как** сотрудник с включённой 2FA **я хочу**, чтобы после ввода пароля система спрашивала код из
аутентификатора и до этого не давала никакого доступа, **чтобы** украденный пароль сам по себе не
открывал ни одной страницы моего рабочего пространства.

## Acceptance (Given/When/Then)

1. **Пароль даёт только промежуточный токен.**
   Given пользователь с `totpEnabledAt IS NOT NULL`;
   When `POST /api/v1/auth/login` с верным паролем;
   Then ответ 200 `{ status: 'mfa_required', mfaToken }`, где `mfaToken` — JWT со `scope =
   'mfa_pending'`, субъектом `pending:{userId}`, TTL 5 минут; **ни access-, ни refresh-токен не
   выдаются**, `Session` не создаётся.

2. **Верификация даёт сессию.**
   Given валидный `mfaToken` и корректный TOTP-код;
   When `POST /api/v1/auth/2fa/verify`;
   Then создаётся `Session`, выдаются access-токен (с `permissionsVersion`) и refresh-cookie;
   `mfaToken` инвалидируется немедленно (одноразовость через денилист в Redis по `jti`);
   в `AuditLog` — `user.login` с признаком `mfa: totp`.

3. **Негативный сценарий — промежуточный токен не работает нигде больше.**
   Given `mfaToken`;
   When он предъявляется на **любом** маршруте из `ROUTE_REGISTRY`, кроме `/auth/2fa/verify`;
   Then 401 `not_authenticated`. Проверяется **табличным тестом по всему реестру**
   (`mfa-pending-token-rejected-everywhere`), а не выборочно — это прямая митигация `T-IAM-04`.

4. **Негативный сценарий — истёкший промежуточный токен.**
   Given прошло больше 5 минут;
   When предъявляется `mfaToken`;
   Then 401 `mfa_token_expired`, пользователь возвращается на шаг ввода пароля; повторный пароль
   выдаёт новый `mfaToken` (старый уже в денилисте).

5. **Негативный сценарий — неверный код.**
   Given введён неверный TOTP-код;
   When приходит `verify`;
   Then 401 `invalid_totp_code`; счётчик попыток привязан **к `mfaToken`**: после 5 неудач токен
   аннулируется целиком и требуется повторный ввод пароля; параллельно работает лимит по IP+email.

6. **Негативный сценарий — replay кода.**
   Given код успешно использован в текущем 30-секундном шаге;
   When он предъявляется повторно;
   Then 401 `totp_code_replayed` (сравнение с сохранённым `totp_last_counter`).

7. **Вход по коду восстановления.**
   Given у пользователя нет аутентификатора;
   When на том же шаге он вводит код восстановления;
   Then применяется путь из [STORY-013-02](story-013-02-recovery-codes.md): код гасится атомарно,
   сессия выдаётся, владельцу уходит уведомление.

8. **Неразличимость на шаге пароля.**
   Given несуществующий пользователь и существующий с неверным паролем;
   When выполняется логин;
   Then тело ответа и медиана времени совпадают (фиктивная проверка Argon2 при отсутствии
   пользователя); факт «у этого адреса включена 2FA» не раскрывается до успешной проверки пароля
   (`T-IAM-03`).

9. **Rate limiting до KDF.**
   Given флуд логинами;
   When превышен лимит 5 попыток за 15 минут по IP+email;
   Then 429 **до** вызова Argon2; конкурентность хеширования ограничена семафором, метрика
   `argon2_inflight` под алертом (`T-IAM-08`).

10. **Устройство запоминать нельзя.**
    Given успешный вход со вторым фактором;
    When пользователь входит с нового устройства;
    Then второй фактор спрашивается снова — «доверенные устройства» в M2 не реализуются
    сознательно (см. «Вне скоупа» эпика).

11. **UI-поток.**
    Given экран входа;
    When требуется второй фактор;
    Then показывается отдельный шаг с полем `autocomplete="one-time-code"`, ссылкой «использовать
    код восстановления», таймером жизни `mfaToken` и понятной ошибкой; экран проходит axe без
    нарушений A/AA и локализован EN/RU.

12. **Публичность маршрутов объявлена.**
    Given `/auth/login` и `/auth/2fa/verify`;
    When проверяется `ROUTE_REGISTRY`;
    Then обе записи имеют `public: true` с непустым `publicReason`; список публичных маршрутов
    снапшотится и его изменение требует ревью.

## Задачи

- [ ] `packages/server/src/application/auth/use-cases/login.use-case.ts` — ветка «2FA включена» →
      выдача `mfaToken` вместо сессии.
- [ ] `packages/server/src/application/auth/use-cases/verify-second-factor.use-case.ts`.
- [ ] `packages/server/src/infrastructure/auth/mfa-token.service.ts` — выпуск/проверка JWT со
      `scope = mfa_pending`, `jti`-денилист в Redis, TTL 5 минут.
- [ ] `packages/server/src/presentation/http/middleware/auth.middleware.ts` — явная проверка
      `scope !== 'mfa_pending'` для всех защищённых маршрутов.
- [ ] `packages/server/src/infrastructure/rate-limit/login.limiter.ts`,
      `mfa-verify.limiter.ts` (лимит на токен + на IP).
- [ ] `packages/server/src/presentation/http/routes/registry.ts` — публичные записи с `publicReason`.
- [ ] `packages/client/src/app/routes/login.tsx` (+ шаг `two-factor`),
      `pages/login/ui/two-factor-step.component.tsx`,
      `units/auth/service/mutations/verify-second-factor.mutation.ts`,
      `units/auth/model/validation/two-factor.schema.ts`.
- [ ] Тесты: `mfa-pending-token-rejected-everywhere.spec.ts` (табличный по `ROUTE_REGISTRY`),
      `verify-second-factor.use-case.spec.ts` (п. 4–6), `auth-timing-equality.spec.ts` (п. 8),
      `login-flood-memory` нагрузочный (п. 9), e2e `login-with-2fa.spec.ts` + axe.

## Ссылки

- [`threat-model.md`, `T-IAM-04` («отдельный тип токена с `scope=mfa_pending`, TTL 5 мин»),
  `T-IAM-03`, `T-IAM-08`, `T-IAM-05`](../../../docs/security/threat-model.md)
- [`data-model.md`, группа 1, `Session`, `permissionsVersion` в токене](../../../docs/architecture/data-model.md)
- [`permission-model.md` §9в (реестр маршрутов, публичные записи)](../../../docs/security/permission-model.md)
- [`ux-architecture.md`, «Публичная зона», «Формы»](../../../docs/architecture/ux-architecture.md)

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
