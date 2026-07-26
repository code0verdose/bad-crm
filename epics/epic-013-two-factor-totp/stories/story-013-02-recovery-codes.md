---
id: STORY-013-02
epic: EPIC-013
status: backlog
blocked: false
priority: must
estimate: M
---

# STORY-013-02 — Коды восстановления

**Как** сотрудник **я хочу** получить набор одноразовых кодов восстановления при включении 2FA,
**чтобы** потеря телефона не означала потерю доступа к рабочему пространству и обращение к
администратору.

## Acceptance (Given/When/Then)

1. **Генерация при включении.**
   Given пользователь подтвердил TOTP;
   When завершается `confirm`;
   Then генерируются 10 кодов по 10 символов из безопасного алфавита (без похожих `0/O`, `1/l`),
   каждый из CSPRNG; ответ содержит их **открытым текстом ровно один раз**; в БД — только
   argon2id-хеши в таблице `mfa_recovery_codes`.

2. **Показ один раз.**
   Given коды выданы;
   When пользователь обновляет страницу или повторно запрашивает список;
   Then открытые значения недоступны навсегда: API отдаёт только счётчик
   `{ total: 10, remaining: 10 }`; UI перед закрытием требует подтвердить «я сохранил коды»
   и предлагает скачать `.txt` / распечатать.

3. **Одноразовость под конкуренцией.**
   Given валидный неиспользованный код;
   When он предъявляется двумя параллельными запросами;
   Then ровно один успешен: пометка выполняется атомарным
   `UPDATE mfa_recovery_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id`,
   выдача сессии — только при вернувшейся строке (конкурентный тест на N параллельных запросов).

4. **Вход по коду восстановления.**
   Given у пользователя нет доступа к аутентификатору;
   When он вводит код восстановления на шаге второго фактора;
   Then сессия выдаётся, код помечается использованным, в `AuditLog` —
   `user.mfa_recovery_code_used` (`severity = warning`), владельцу уходит уведомление (in-app
   всегда, email при настроенном SMTP).

5. **Негативный сценарий — повторное использование.**
   Given код уже использован;
   When он вводится снова;
   Then 401 с тем же телом и тем же временем ответа, что и для несуществующего кода
   (неразличимость), попытка учитывается лимитером.

6. **Предупреждение об исчерпании.**
   Given остаётся ≤ 3 неиспользованных кода;
   When пользователь входит;
   Then в интерфейсе — постоянный баннер «осталось N кодов, перевыпустите набор»; при 0 оставшихся
   вход по кодам невозможен, доступен только TOTP или сброс администратором.

7. **Перевыпуск набора.**
   Given пользователь запрашивает новые коды;
   When `POST /api/v1/auth/2fa/recovery-codes/regenerate` с подтверждением паролем и текущим
   TOTP-кодом;
   Then **все** старые хеши удаляются в той же транзакции, выдаётся новый набор из 10 кодов, в
   `AuditLog` — `user.mfa_recovery_codes_regenerated`.

8. **Негативный сценарий — перевыпуск без подтверждения.**
   Given запрос без пароля или без действующего TOTP-кода;
   When он приходит;
   Then 403 `reauthentication_required`; старые коды остаются рабочими.

9. **Хеши, а не значения.**
   Given таблица `mfa_recovery_codes`;
   When она читается напрямую;
   Then в ней только `code_hash` (argon2id с параметрами не ниже OWASP), `used_at`, `created_at`;
   plaintext-колонки нет; grep-тест логов не находит кодов; сравнение — с фиктивной проверкой при
   отсутствии совпадения, чтобы время ответа не выдавало существование кода.

10. **Rate limiting.**
    Given перебор кодов восстановления;
    When превышено 5 попыток за 15 минут на пользователя и на IP;
    Then 429 с `Retry-After`; серия неудач пишется одной агрегированной записью в `AuditLog` и
    метрикой `mfa_recovery_failed_total`.

11. **Кросс-тенантность.**
    Given коды пользователя организации B;
    When они предъявляются в контексте организации A;
    Then 401 без раскрытия причины; RLS изолирует таблицу, isolation-тест это подтверждает.

## Задачи

- [ ] `packages/server/prisma/migrations/*_mfa_recovery_codes/migration.sql` — таблица с
      `organization_id`, `user_id`, `code_hash`, `used_at`, индекс
      `idx_mfa_recovery_user (organization_id, user_id) WHERE used_at IS NULL`,
      RLS `ENABLE` + `FORCE` + политики, `REVOKE UPDATE` не применяется (нужен `used_at`).
- [ ] `packages/server/src/application/auth/use-cases/generate-recovery-codes.use-case.ts`,
      `consume-recovery-code.use-case.ts`, `regenerate-recovery-codes.use-case.ts`.
- [ ] `packages/server/src/application/auth/ports/password-hasher.port.ts` — переиспользование
      argon2id-адаптера для хеширования кодов.
- [ ] `packages/server/src/domain/auth/recovery-code.value.ts` — алфавит, длина, нормализация
      (регистр, дефисы).
- [ ] `packages/server/src/presentation/http/routes/registry.ts` — `2fa/recovery-codes`,
      `2fa/recovery-codes/regenerate`.
- [ ] `packages/client/src/widgets/recovery-codes/recovery-codes.widget.tsx` +
      `ui/recovery-codes-list.component.tsx`, `ui/recovery-codes-confirm.component.tsx`,
      скачивание `.txt` и печать; баннер `ui/recovery-codes-low-banner.component.tsx`.
- [ ] `packages/client/src/units/auth/service/mutations/regenerate-recovery-codes.mutation.ts`.
- [ ] Тесты: `consume-recovery-code.use-case.spec.ts`, конкурентный
      `recovery-code-race.spec.ts` (п. 3), `recovery-code-timing.spec.ts` (п. 9),
      интеграционные п. 5, 7, 8, 10, isolation-тест таблицы, e2e «вход по коду восстановления».

## Ссылки

- [`threat-model.md`, `T-IAM-04` («recovery-коды хранятся argon2id-хешами и помечаются
  использованными атомарно»), `T-IAM-03`](../../../docs/security/threat-model.md)
- [`stack.md`, `@node-rs/argon2`](../../../docs/architecture/stack.md)
- [`ux-architecture.md`, `/settings/security`, «Копирование секрета в буфер»](../../../docs/architecture/ux-architecture.md)
- [`rls-design.md`, чек-лист «новая таблица»](../../../docs/security/rls-design.md)
- PRD: NFR-6

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
