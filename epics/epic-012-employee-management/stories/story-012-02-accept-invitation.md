---
id: STORY-012-02
epic: EPIC-012
status: backlog
blocked: false
priority: must
estimate: M
---

# STORY-012-02 — Принятие приглашения и активация аккаунта

**Как** приглашённый сотрудник **я хочу** перейти по ссылке, задать пароль и сразу попасть в
рабочее пространство с уже выданными ролью и командами, **чтобы** первый рабочий день не начинался
с переписки «а дайте доступ».

## Acceptance (Given/When/Then)

1. **Успешное принятие.**
   Given валидный непросроченный токен приглашения с `roleId` и `teamIds`;
   When `POST /api/v1/invitations/accept` с `{ token, password, firstName, lastName, locale }`;
   Then **в одной транзакции**: создаётся `User(status = ACTIVE, permissionsVersion = 1)`, пустой
   `EmployeeProfile`, `UserRole`, `TeamMember` для каждой команды; `Invitation.acceptedAt` и
   `acceptedUserId` проставлены; выдаётся пара токенов сессии; в `AuditLog` — `invitation.accepted`.

2. **Одноразовость.**
   Given приглашение уже принято;
   When тот же токен предъявляется снова;
   Then 410 `invitation_not_valid`; второго пользователя не создаётся (проверяется конкурентным
   тестом: N параллельных запросов → ровно одно успешное принятие).

3. **Негативный сценарий — привязка к e-mail.**
   Given приглашение выдано на `ivan@acme.dev`;
   When в теле передан `email: "petr@acme.dev"`;
   Then поле игнорируется полностью (входная Zod-схема `.strict()` его не содержит) — аккаунт
   создаётся строго на `Invitation.email`.

4. **Негативный сценарий — просроченное приглашение.**
   Given `expiresAt < now`;
   When токен предъявляется;
   Then 410 с тем же телом и тем же временем ответа, что и для отозванного и несуществующего токена
   (неразличимость состояний, `T-IAM-03`).

5. **Негативный сценарий — слабый пароль.**
   Given пароль короче политики организации;
   When приходит запрос;
   Then 422 с inline-ошибкой поля (не тост); пользователь не создан; проверка выполняется той же
   Zod-схемой, что и при регистрации.

6. **Хеширование и тайминг.**
   Given принятие приглашения;
   When вычисляется `passwordHash`;
   Then используется Argon2id с параметрами из env; rate-limit применяется **до** вызова KDF, а
   конкурентность хеширования ограничена семафором (`T-IAM-08`).

7. **Политика обязательной 2FA.**
   Given в организации включена обязательная 2FA для роли приглашённого;
   When приглашение принято;
   Then пользователь попадает на экран настройки TOTP и до её завершения имеет доступ только к
   маршрутам настройки второго фактора (стыковка с
   [STORY-013-05](../../epic-013-two-factor-totp/stories/story-013-05-org-2fa-policy.md)).

8. **Негативный сценарий — организация деактивирована.**
   Given `Organization.deletedAt IS NOT NULL`;
   When предъявляется валидный токен;
   Then 410 без раскрытия причины.

9. **Rate limiting и перебор.**
   Given атакующий перебирает токены;
   When превышен лимит 10 попыток за 15 минут с IP;
   Then 429; неудачные попытки логируются метрикой, но не заполняют `AuditLog` построчно.

10. **Публичность маршрута объявлена явно.**
    Given маршрут `POST /invitations/accept`;
    When проверяется `ROUTE_REGISTRY`;
    Then запись имеет `public: true` с непустым `publicReason` («приём приглашения выполняется до
    появления сессии»); маршрут исполняется через ограниченный пул `app_auth` и
    `SECURITY DEFINER`-путь (см. `rls-design.md`, «Путь 1»).

## Задачи

- [ ] `packages/server/src/application/iam/use-cases/accept-invitation.use-case.ts` — одна
      транзакция, атомарный `UPDATE ... WHERE accepted_at IS NULL RETURNING` для одноразовости.
- [ ] `packages/server/src/domain/iam/invitation.entity.ts` — проверки `isAcceptable(now)`.
- [ ] `packages/server/src/presentation/http/validators/accept-invitation.validator.ts` — Zod
      `.strict()`, политика пароля из `shared/lib/validation`.
- [ ] `packages/server/src/presentation/http/routes/registry.ts` — публичная запись с `publicReason`.
- [ ] `packages/server/src/infrastructure/persistence/prisma/invitation.repository.ts` — резолв по
      `tokenHash` через ограниченную роль `app_auth`.
- [ ] `packages/client/src/app/routes/invite.$token.tsx` (публичная зона) +
      `pages/accept-invite/page.tsx`, `widgets/accept-invite-form/accept-invite-form.widget.tsx`.
- [ ] `packages/client/src/units/auth/model/validation/accept-invitation.schema.ts`.
- [ ] i18n: `packages/client/src/app/i18n/{en,ru}/invite.json`.
- [ ] Тесты: `accept-invitation.use-case.spec.ts`, конкурентный `accept-invitation-race.spec.ts`
      (п. 2), интеграционные на п. 3, 4, 8, 9, e2e «приглашение → пароль → рабочий стол» + axe.

## Ссылки

- [`threat-model.md`, `T-IAM-10`, `T-IAM-03`, `T-IAM-08`](../../../docs/security/threat-model.md)
- [`rls-design.md`, «Путь 1. Логин: организация ещё не известна»](../../../docs/security/rls-design.md)
- [`data-model.md`, группа 1, `Invitation`, `User.status`](../../../docs/architecture/data-model.md)
- [`ux-architecture.md`, «Публичная зона», «Формы»](../../../docs/architecture/ux-architecture.md)

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
