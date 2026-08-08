---
id: STORY-012-01
epic: EPIC-012
status: review
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

- [x] `packages/server/prisma/migrations/*_invitations/migration.sql` — таблица `invitations`
      (`email`, `role_id`, `team_ids uuid[]`, `token_hash`, `invited_by_id`, `expires_at`,
      `accepted_at`, `accepted_user_id`), `uq_invitations_token`, частичный
      `idx_invitations_org_email (organization_id, email) WHERE accepted_at IS NULL`,
      RLS `ENABLE` + `FORCE` + `tenant_isolation` (USING = WITH CHECK) + `maintenance_access`.
- [x] Три use-case в одном файле `write-invitation.use-case.ts` (create/resend/revoke — одна
      сущность, один транзакционный контур) и `list-invitations.query.ts`.
- [x] `packages/server/src/domain/iam/access/invitation-access.policy.ts` — правило «роль
      приглашения ⊆ **эффективные** права приглашающего».
- [x] `packages/server/src/application/iam/ports/invitation-repository.port.ts`; отдельный
      `mailer.port.ts` не понадобился — `MailPort`/`MailDispatchPort` из EPIC-006 уже описывают ровно
      это, включая «нет SMTP» как отдельное состояние, а не как ошибку.
- [x] Шаблон письма — `domain/iam/invitation-mail.util.ts` (EN/RU). В `domain`, а не в
      `infrastructure/mail`: рендер — чистая функция без I/O, и рядом с ним лежит письмо сброса
      пароля.
- [x] `route-registry.factory.ts` — `invitation:read/create/resend/revoke`.
- [x] `packages/client/src/app/routes/_authenticated/admin/members/invite.tsx` +
      `widgets/invite-member/invite-member.widget.tsx`, `units/iam/model/validation/invitation.schema.ts`,
      `units/iam/service/mutations/create-invitation.mutation.ts`.
- [x] Тесты: политика (10), use-case'ы (24), письмо (4), репозиторий (12), HTTP-поверхность (15),
      isolation-тест `invitations`, клиент (13).

## Что сделано (2026-08-07)

- [x] Таблица `invitations` — миграция `20260807100000_invitations`: `token_hash` вместо токена,
      составные внешние ключи с `organization_id` первой колонкой (проверки FK обходят RLS),
      `uq_invitations_token` **глобально уникальный** (дайджест и есть предъявляемая учётная запись),
      частичный уникальный `idx_invitations_org_email ... WHERE accepted_at IS NULL` — одно открытое
      приглашение на адрес, закрытое остаётся историей. Полный блок RLS (`ENABLE` + `FORCE` +
      `tenant_isolation` с обоими предикатами + `maintenance_access`), явные GRANT-ы, три CHECK-а:
      адрес похож на адрес, срок больше даты создания, «принято» и «принято кем» движутся вместе.
- [x] Isolation-тесты генерируются из реестра `TENANT_TABLES` — добавление таблицы туда сразу дало
      17 падающих тестов, пока не появилась row-фабрика (гейт сработал как задумано).
- [x] `domain/iam/access/invitation-access.policy.ts` — `canInvite` (правило подмножества
      `T-IAM-09` по **эффективному** праву, то есть с вычетом DENY-оверрайдов; владелец исключён),
      `canResendInvitation`/`canRevokeInvitation` — отдельные capability и отказ
      `invitation_already_accepted` для принятого. 10 табличных тестов.
- [x] `CreateInvitationUseCase` / `ResendInvitationUseCase` / `RevokeInvitationUseCase`: токен
      выдаётся **ровно один раз** в ответе, в хранилище идёт только дайджест, в журнал — адрес, роль
      и срок (тест утверждает, что токена нет ни там, ни там). Переотправка выписывает **новый**
      токен и убивает старый одним оператором. 14 тестов.
- [x] Новая причина отказа `invitation_already_accepted` проведена через все закрытые словари:
      `DENY_REASONS`, `ErrorCode` (409), маппинг `CODE_FOR`, спека, обе локали клиента и
      `permission-model.md` (документ правится первым — гейт `catalog-matches-model` это проверяет).
- [x] Действия журнала `invitation.created` / `.resent` / `.revoked` и тип цели `INVITATION`;
      уровни — `WARNING` для создания и переотправки, `INFO` для отзыва.

- [x] Репозиторий `PrismaInvitationRepository`: ни один read не выбирает `token_hash` (утечка
      невозможна конструктивно, а не по внимательности), `accepted_at IS NULL` стоит **в предикате**
      обоих write-ов, а не в чтении перед ними. 12 юнит-тестов на форму запросов.
- [x] Четыре маршрута: `GET /invitations` (`invitation:read`), `POST /invitations`
      (`invitation:create`, идемпотентность), `POST /invitations/{id}/resend` (`invitation:resend`),
      `DELETE /invitations/{id}` (`invitation:revoke`). Снапшот матрицы прав пересчитан: owner/admin/
      manager — allow, остальные — `permission_not_granted`, id-маршруты на несуществующем
      приглашении отвечают **404**, а не 403.
- [x] Rate limit `invitation_create` — 20 за 10 минут на приглашающего, тратится **до** записи и до
      чтения адреса (иначе endpoint — и почтовая пушка, и оракул существования аккаунтов, `T-IAM-10`).
      Тот же бюджет тратит переотправка. Таблица в `stack.md` дополнена (заодно записан
      `client_error_report`, которого в ней не было).
- [x] Письмо `domain/iam/invitation-mail.util.ts` (EN/RU): токен только в пути ссылки, дата
      истечения в календаре читателя (UTC, и это сказано в тексте), имя организации экранируется.
      Язык письма — колонка `invitations.locale`: у получателя ещё нет учётной записи, из которой
      можно взять язык, и переотправка обязана повторить то же письмо.
- [x] Без SMTP операция **успешна** (NFR-9): `mailDispatched: false`, ссылка в ответе, на экране —
      предупреждение и кнопка «скопировать».
- [x] Экран `/admin/members/invite`: форма (`@mantine/form` + та же zod-схема, что парсит тело
      запроса), панель со ссылкой, namespace `members` в обеих локалях. 13 тестов — компонентных и
      сквозных против застабленного сервера.
- [x] 15 интеграционных HTTP-тестов: 201 со ссылкой, письмо с той же ссылкой, дайджест не попадает
      на провод, 403 на превышение прав, 404 на чужую роль, 409 на существующий аккаунт и на второе
      открытое приглашение, 429 с `Retry-After`, новый токен на resend убивает старый, 409 на
      принятое, 404 на повторный revoke.

### Расхождения, решённые в пользу `docs/` (не молча)

1. **`invitation_already_pending` → `invitation_already_exists`.** История называет первый код;
   `docs/api/openapi.yaml` (источник истины по контракту) публикует второй, и он же выводится из
   закрытого правила `${ErrorResource}_already_exists`, которым `TenantScopedRepository` переводит
   нарушение уникального индекса. Отдельный код потребовал бы исключения из этого правила ради
   синонима. Взят код из спеки.
2. **Гард экрана: `user:invite` → `invitation:create`.** `ux-architecture.md` закрывал экран правом
   `user:invite`, а endpoint проверяет `invitation:create`. Системные роли выдают их вместе, но
   кастомная роль может разделить — и тогда экран открывается и отказывает на первом же действии.
   Документ поправлен первым, правило записано в раздел «Клиентская проверка — только подсказка».
3. **`invitations.locale`.** Новая колонка, которой не было в `data-model.md`: письмо получателю без
   учётной записи иначе нечем локализовать, а resend обязан повторить тот же язык. Документ
   дополнен до кода.
4. **Миграция правится на месте.** `20260807100000_invitations` меняется вторым коммитом подряд
   (`token_hash` → `BYTEA` как все дайджесты схемы, плюс `locale`). Формально это исключение из
   правила 12 `rules/db-migrations.mdc`; таблица не выпущена, не запушена и не применена ни к одной
   постоянной базе. Кто применял её локально — `prisma migrate reset`.

### Осталось за пределами этой истории

`GET /invitations`, `POST /invitations/{id}/resend` и `DELETE /invitations/{id}` существуют на
сервере и закрыты тестами, но клиент их не вызывает: клиентских функций
`fetchInvitations`/`resend`/`revoke` нет — функция, которую никто не вызывает, это контракт, который
никто не проверяет.

**У экрана списка приглашений владельца пока нет, и это осознанная дыра, а не забытая строчка.**
Изначально он был отписан на STORY-012-04, но справочник сознательно от него отказался: справочник
перечисляет учётные записи, а непринятое приглашение — не учётная запись (разбор — в
[`data-model.md`](../../../docs/architecture/data-model.md), «Про `User.status = INVITED`»). Экран
нужно завести отдельной историей эпика; до тех пор пригласивший видит ссылку один раз — в ответе на
создание, — и переотправить её из интерфейса нельзя.

**Бюджет бандла.** Экран добавил ~3 kB gzip к initial JS: 244.5 → 247.8 kB при лимите 250. Первая
версия с `Select` не проходила (257.7) — заменён на `NativeSelect`, который не тянет `Combobox` и
его popover. Запас 2.2 kB: следующий экран, скорее всего, потребует разобраться, почему `pages-*.js`
вообще попадает в первую отрисовку.

## Ссылки

- [`data-model.md`, группа 1, `Invitation` и индексы](../../../docs/architecture/data-model.md)
- [`threat-model.md`, `T-IAM-10`, `T-IAM-03`, `T-IAM-09`](../../../docs/security/threat-model.md)
- [`permission-model.md` §3.2](../../../docs/security/permission-model.md)
- [`ux-architecture.md`, `/admin/members/invite`](../../../docs/architecture/ux-architecture.md)
- PRD: NFR-9 (автономность от внешних SaaS)

## Definition of Done

- [x] Тесты написаны первыми (TDD), проходят, изменённый код покрыт (базовая линия покрытия не
      просела: server 99.34 lines, client 100)
- [x] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [x] Документация обновлена (`stack.md`, `data-model.md`, `ux-architecture.md`, `openapi.yaml` +
      запись в `docs/brain/`)
- [x] a11y и i18n (нативный `<select>`, `role="status"` на панели со ссылкой, обе локали, ноль
      хардкод-строк)
- [x] **Isolation-тест RLS** для таблицы `invitations` (генерируется из `TENANT_TABLES`)
- [x] **Permission объявлена** для всех четырёх endpoint'ов и проверяется в use-case
