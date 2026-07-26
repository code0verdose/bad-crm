---
id: STORY-013-01
epic: EPIC-013
status: backlog
blocked: false
priority: must
estimate: M
---

# STORY-013-01 — Включение TOTP по QR-коду

**Как** сотрудник **я хочу** привязать приложение-аутентификатор, отсканировав QR-код и подтвердив
владение одним кодом, **чтобы** мой аккаунт нельзя было захватить одним лишь украденным паролем.

## Acceptance (Given/When/Then)

1. **Инициация привязки.**
   Given аутентифицированный пользователь без включённой 2FA;
   When `POST /api/v1/auth/2fa/setup`;
   Then сервер генерирует секрет (base32, ≥ 160 бит энтропии) и возвращает **один раз**
   `otpauth://totp/BadCRM:{email}?secret=…&issuer=BadCRM&algorithm=SHA1&digits=6&period=30`
   плюс SVG QR-кода; секрет сохраняется как **черновой** (`totpSecretEnc` заполнен,
   `totpEnabledAt = null`), поэтому 2FA ещё не действует.

2. **Подтверждение владения.**
   Given черновой секрет и код из аутентификатора;
   When `POST /api/v1/auth/2fa/confirm` с `{ code }`;
   Then при совпадении проставляется `totpEnabledAt = now`, генерируются коды восстановления
   ([STORY-013-02](story-013-02-recovery-codes.md)), в `AuditLog` — `user.mfa_enabled`
   (`severity = warning`); ответ 200.

3. **Негативный сценарий — без подтверждения 2FA не включена.**
   Given пользователь получил QR, но код не ввёл;
   When он выходит и логинится снова;
   Then второй фактор не спрашивается, черновой секрет истекает через 15 минут и удаляется джобом;
   повторный `setup` выдаёт **новый** секрет (старый инвалидируется).

4. **Негативный сценарий — неверный код.**
   Given введён код с ошибкой;
   When приходит `confirm`;
   Then 422 `invalid_totp_code` без раскрытия, «насколько» код неверен; после 5 неудач подряд —
   429 с экспоненциальной задержкой, черновой секрет аннулируется, событие в `AuditLog`.

5. **Окно дрейфа часов зафиксировано.**
   Given часы клиента отстают на 25 секунд;
   When код проверяется;
   Then он принимается (`window = 1`, то есть ±1 шаг по 30 c); код, отстающий на 90 секунд,
   отклоняется — граница покрыта тестом с фиксированным `ClockPort`.

6. **Одноразовость кода внутри окна.**
   Given код `123456` только что успешно использован;
   When тот же код предъявляется повторно в пределах того же 30-секундного шага;
   Then 422 `totp_code_replayed`: последний принятый `counter` сохраняется и сравнивается
   (защита от подсматривания через плечо и от replay).

7. **Негативный сценарий — секрет не покидает сервер повторно.**
   Given 2FA уже включена;
   When вызывается `setup` ещё раз;
   Then 409 `mfa_already_enabled`; секрет невозможно прочитать через API ни при каких условиях;
   grep-тест по e2e-логам не находит base32-секрета.

8. **Секрет зашифрован в БД.**
   Given запись `users`;
   When она читается напрямую из БД;
   Then `totp_secret_enc` — шифротекст с префиксом версии ключа (`v1:`), `APP_ENCRYPTION_KEY`
   ровно 32 байта base64; plaintext-колонки не существует (структурный тест схемы).

9. **Кросс-тенантность и подделка субъекта.**
   Given тело запроса содержит `userId`;
   When запрос обрабатывается;
   Then поле игнорируется — актор берётся из `AsyncLocalStorage`-контекста сессии (`.strict()`-схема).

10. **a11y и i18n.**
    Given экран `/settings/security`;
    When он проверяется axe и с клавиатуры;
    Then 0 нарушений A/AA, секрет доступен как текст для ручного ввода (не только QR), поле кода
    имеет `inputmode="numeric"` и `autocomplete="one-time-code"`, все строки — EN и RU.

## Задачи

- [ ] `packages/server/src/application/auth/use-cases/setup-totp.use-case.ts`,
      `confirm-totp.use-case.ts`.
- [ ] `packages/server/src/application/auth/ports/totp.port.ts` +
      `infrastructure/crypto/otplib-totp.adapter.ts` (`otplib`, `window: 1`, `digits: 6`,
      `period: 30`).
- [ ] `packages/server/src/infrastructure/crypto/field-encryption.adapter.ts` — шифрование
      `totpSecretEnc` с префиксом версии ключа.
- [ ] `packages/server/prisma/migrations/*_totp/migration.sql` — `users.totp_secret_enc`,
      `totp_enabled_at`, `totp_last_counter`, `totp_draft_expires_at`.
- [ ] `packages/server/src/presentation/http/routes/registry.ts` — маршруты `2fa/setup`, `2fa/confirm`
      (требуют сессии; `permission` не нужен — операция над собой, зафиксировать `publicReason`-аналог
      комментарием `selfService: true` в реестре).
- [ ] `packages/server/src/infrastructure/rate-limit/totp-attempts.limiter.ts` (Redis).
- [ ] `packages/client/src/units/auth/service/{mutations,hooks}` — `setup-totp.mutation.ts`,
      `confirm-totp.mutation.ts`, `use-totp-setup.hook.ts`.
- [ ] `packages/client/src/widgets/totp-setup/totp-setup.widget.tsx` +
      `ui/totp-qr.component.tsx`, `ui/totp-code-field.component.tsx`.
- [ ] i18n: `packages/client/src/app/i18n/{en,ru}/security.json`.
- [ ] Тесты: `otplib-totp.adapter.spec.ts` (RFC 6238 тестовые векторы), `confirm-totp.use-case.spec.ts`
      (п. 4–6 с фиксированным `ClockPort`), структурный тест шифрования секрета,
      grep-тест логов, e2e `enable-2fa.spec.ts` + axe.

## Ссылки

- [`threat-model.md`, `T-IAM-04`, `T-IAM-08`, `T-SH-04`](../../../docs/security/threat-model.md)
- [`data-model.md`, группа 1, `User.totpSecretEnc`, `totpEnabledAt`](../../../docs/architecture/data-model.md)
- [`stack.md`, `otplib`, «Безопасность в коде»](../../../docs/architecture/stack.md)
- [`ux-architecture.md`, `/settings/security`, «Формы»](../../../docs/architecture/ux-architecture.md)
- PRD: NFR-6

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
