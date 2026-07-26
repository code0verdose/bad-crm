---
id: STORY-012-01
epic: EPIC-012
status: backlog
blocked: false
priority: must
estimate: M
---

# STORY-012-01 — Приглашение сотрудника по e-mail

**Как** администратор системы (P5) **я хочу** пригласить человека по e-mail, сразу задав ему роль и
команды, **чтобы** онбординг был одной операцией, а не «создам аккаунт, потом вспомню про доступы».

## Acceptance (Given/When/Then)

1. **Создание приглашения.**
   Given администратор с правами `user:invite` и `invitation:create`;
   When `POST /api/v1/invitations` с `{ email: "ivan@acme.dev", roleId, teamIds: [t1], message? }`;
   Then создаётся `Invitation` с `tokenHash` (SHA-256 от 32 байт CSPRNG), `expiresAt = now + 7d`,
   `invitedById`, `acceptedAt = null`; в БД **сырого токена нет**; ответ 201 содержит ссылку
   приглашения ровно один раз.

2. **Работа без SMTP.**
   Given `SMTP_HOST` не задан (NFR-9);
   When создаётся приглашение;
   Then операция успешна, письмо не отправляется, интерфейс показывает ссылку с кнопкой «копировать»
   и предупреждением «почта не настроена — передайте ссылку сами»; отсутствие SMTP не является
   ошибкой запроса.

3. **Повторная отправка.**
   Given приглашение старше суток и не принято;
   When `POST /api/v1/invitations/{id}/resend` (право `invitation:resend`);
   Then генерируется **новый** токен, старый `tokenHash` перестаёт работать немедленно, `expiresAt`
   продлевается, событие в `AuditLog`.

4. **Отзыв приглашения.**
   Given активное приглашение;
   When `DELETE /api/v1/invitations/{id}` (право `invitation:revoke`);
   Then токен инвалидируется немедленно; последующая попытка принять даёт тот же ответ, что и для
   несуществующего токена (неразличимость).

5. **Негативный сценарий — нельзя пригласить с ролью выше своей.**
   Given администратор без `invoice:issue`;
   When он приглашает человека с ролью `manager`, содержащей `invoice:issue`;
   Then 403 `permission_not_granted`; приглашение не создано (митигация `T-IAM-09`).

6. **Негативный сценарий — уже существующий пользователь.**
   Given `ivan@acme.dev` уже активен в этой организации;
   When создаётся приглашение на тот же адрес;
   Then 409 `user_already_exists`; при этом e-mail остаётся уникальным **внутри организации**:
   тот же адрес в другой организации приглашается без конфликта.

7. **Негативный сценарий — дубль активного приглашения.**
   Given активное непринятое приглашение на адрес;
   When создаётся ещё одно;
   Then 409 `invitation_already_pending` со ссылкой на существующее (частичный уникальный индекс
   `idx_invitations_org_email ... WHERE accepted_at IS NULL`).

8. **Негативный сценарий — перечисление адресов.**
   Given атакующий пробует адреса через публичные эндпоинты;
   When он получает ответы;
   Then ответы и их тайминг не позволяют отличить «пользователь есть» от «пользователя нет»:
   различающиеся коды доступны только аутентифицированному актору с `invitation:create`.

9. **Rate limiting.**
   Given один актор;
   When он создаёт больше 20 приглашений за 10 минут;
   Then 429 с `Retry-After`; лимит распределённый (Redis), метрика растёт.

10. **Аудит.**
    Given любая операция с приглашением;
    When она выполняется;
    Then в `AuditLog` — `invitation.created` / `.resent` / `.revoked` с `email`, `roleId`,
    `expiresAt`, актором и `requestId`; **токен и его хеш в журнал не попадают**.

## Задачи

- [ ] `packages/server/prisma/migrations/*_invitations/migration.sql` — таблица `invitations`
      (`email`, `role_id`, `team_ids uuid[]`, `token_hash`, `invited_by_id`, `expires_at`,
      `accepted_at`, `accepted_user_id`), `uq_invitations_token`, частичный
      `idx_invitations_org_email (organization_id, email) WHERE accepted_at IS NULL`,
      RLS `ENABLE` + `FORCE` + `tenant_isolation` (USING = WITH CHECK) + `maintenance_access`.
- [ ] `packages/server/src/application/iam/use-cases/create-invitation.use-case.ts`,
      `resend-invitation.use-case.ts`, `revoke-invitation.use-case.ts`.
- [ ] `packages/server/src/application/iam/queries/list-invitations.query.ts`.
- [ ] `packages/server/src/domain/iam/access/invitation-access.policy.ts` — правило «роль
      приглашения ⊆ права приглашающего», `invitation.errors.ts`.
- [ ] `packages/server/src/application/iam/ports/invitation-repository.port.ts`, `mailer.port.ts`
      (реализация — nodemailer, отсутствие SMTP = no-op с флагом в ответе).
- [ ] `packages/server/src/infrastructure/mail/invitation.template.ts` (EN/RU).
- [ ] `packages/server/src/presentation/http/routes/registry.ts` — `invitation:read/create/resend/revoke`.
- [ ] `packages/client/src/app/routes/_authenticated/admin/members/invite.tsx` +
      `widgets/invite-member/invite-member.widget.tsx`, `units/iam/model/validation/invitation.schema.ts`,
      `units/iam/service/mutations/create-invitation.mutation.ts`.
- [ ] Тесты: `invitation-access.policy.spec.ts`, интеграционные `invitations-api.spec.ts`
      (п. 3–7, 9), `invitation-token-hashed.spec.ts`, isolation-тест `invitations`,
      компонентный на копирование ссылки без SMTP.

## Ссылки

- [`data-model.md`, группа 1, `Invitation` и индексы](../../../docs/architecture/data-model.md)
- [`threat-model.md`, `T-IAM-10`, `T-IAM-03`, `T-IAM-09`](../../../docs/security/threat-model.md)
- [`permission-model.md` §3.2](../../../docs/security/permission-model.md)
- [`ux-architecture.md`, `/admin/members/invite`](../../../docs/architecture/ux-architecture.md)
- PRD: NFR-9 (автономность от внешних SaaS)

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
