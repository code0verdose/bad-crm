---
id: STORY-006-01
epic: EPIC-006
status: in-progress
blocked: false
priority: must
estimate: M
---

# STORY-006-01 — Регистрация организации и владельца

**Как** владелец инсталляции **я хочу** создать организацию и учётную запись владельца через
интерфейс **чтобы** начать пользоваться развёрнутым экземпляром без правки конфигов и SQL.

## Acceptance (Given/When/Then)

- **Given** пустая инсталляция **When** отправляю форму регистрации с названием организации, email и паролем **Then** создаются организация, пользователь-владелец и системные роли в одной транзакции, и я оказываюсь аутентифицированным.
- **Given** пароль `qwerty123` **When** отправляю форму **Then** возвращается 422 `validation_failed` с ошибкой по полю `password`; политика (минимум 12 символов, проверка на компрометацию по списку слабых) описана Zod-схемой в `packages/shared` и применяется и на клиенте, и на сервере.
- **Given** сохранённый пароль **When** смотрю строку в БД **Then** это argon2id-хеш с параметрами `memoryCost ≥ 19456`, `timeCost ≥ 2`; сам пароль нигде не логируется и не возвращается.
- **Given** занятый `slug` организации **When** отправляю форму **Then** 409 `organization_already_exists`, ни одна строка не создана, поле формы подсвечено.
- **Given** email в формате `  User@Example.COM ` **When** он сохраняется **Then** он нормализован (`citext`, trim, lower-case), а уникальность проверяется в паре `(organization_id, email)`, а не глобально.
- **Given** параметры argon2 подняты в env **When** пользователь входит со старым хешем **Then** проверка проходит и хеш прозрачно перехешируется новыми параметрами.
- **Given** повторная отправка формы из-за обрыва сети с тем же `Idempotency-Key` **When** запрос приходит второй раз **Then** возвращается сохранённый ответ, вторая организация не создаётся.
- **Given** уже существующая организация в инсталляции **When** открытая регистрация запрещена настройкой инсталляции **Then** endpoint возвращает 403 `registration_disabled`, а форма недоступна.

## Задачи

- [ ] Написать тесты первыми: `application/identity/use-cases/register-organization.use-case.test.ts` (успех, слабый пароль, занятый slug, откат), `test/integration/auth/register.test.ts` (реальная БД, хеш в БД, нормализация email, идемпотентность), `packages/shared/validation/password.schema.test.ts`.
- [x] Реализовать `packages/shared/src/validation/password.schema.ts` — единая политика пароля для клиента и сервера.
      *Закрыто ревизией 2026-07-28:* файл существует с EPIC-001
      (`packages/shared/src/validation/password.schema.ts:20`) — `passwordSchema` с
      `PASSWORD_MIN_LENGTH = 12` и `PASSWORD_MAX_LENGTH = 128`, без trim и case-folding, одна схема
      на клиент и сервер; те же границы продублированы в `docs/api/openapi.yaml` (`Password`).
      Пометка стояла невыполненной при уже существующей реализации. **Остаётся в этой истории:**
      проверка на компрометацию/слабость из acceptance (zxcvbn score ≥ 3, top-100k blocklist) —
      сама схема в своём комментарии относит её к use-case'у, который умеет её ещё и rate-limit'ить.
- [x] Добавить модели `User` и `Session` в `schema.prisma` и миграцию с полным блоком RLS и индексами (`uq_users_org_email … WHERE deleted_at IS NULL`, `idx_users_org_status`).
      *Сделано 2026-07-28:* миграция `20260728120000_auth_core_identity_and_sessions` (expand-шаг),
      таблицы `users`/`sessions`/`password_reset_tokens` с `ENABLE`+`FORCE`, политикой
      `tenant_isolation` (`USING` и `WITH CHECK`), `maintenance_access`, явными `GRANT` и составными
      FK; реестр `tenant-tables.constant.ts` + `ROW_FACTORIES`; `pnpm check:rls` и матрица изоляции
      зелёные. **Остаётся в этой истории:** `organizations.owner_id` и `teams.lead_id` (nullable
      expand + бэкфилл) — их проставляет use-case регистрации, поэтому они идут вместе с ним.
- [ ] Реализовать `infrastructure/crypto/argon2-password-hasher.adapter.ts` под портом `PasswordHasherPort` (хеш, проверка, признак необходимости перехеша).
- [ ] Реализовать `application/identity/use-cases/register-organization.use-case.ts` поверх bootstrap-сценария из [STORY-005-06](../../epic-005-multi-tenancy-rls/stories/story-005-06-organization-bootstrap-transaction.md).
- [ ] Добавить операцию `POST /api/v1/auth/register` в `docs/api/openapi.yaml` и реализовать контроллер с валидатором.
      *(2026-07-28: **половина сделана** — операция описана в спеке с маркером
      `x-implemented-by: STORY-006-01`; `Idempotency-Key` обязателен, 403 `registration_disabled`,
      409 `organization_already_exists`, 422 по полю. Поля владельца — `email`, `password`,
      `locale?`, `timezone?`: имени у `User` в `data-model.md` §1 нет, и договор его не выдумывает.
      Контроллер и валидатор — за этой историей.)*
- [ ] Реализовать клиентский экран регистрации: `pages/register`, `units/auth/ui/register-form.component.tsx`, хук `use-register.hook.ts`, схема формы через встроенный `schemaResolver` из `@mantine/form`
      (`validate: schemaResolver(schema, { sync: true })`).
- [ ] Добавить настройку инсталляции «открытая регистрация» и её проверку в use-case.

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, **db-reviewer обязателен**, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y-проверка: форма с корректными `label`, связью ошибок через `aria-describedby`, объявлением ошибок в live-region, полной работой с клавиатуры
- [ ] i18n: строки в обоих языках, хардкода нет

## Ссылки

- Документация: [`stack.md` → Пароли](../../../docs/architecture/stack.md), [`data-model.md` → Tenancy и идентичность](../../../docs/architecture/data-model.md), [`ux-architecture.md` → Публичная зона](../../../docs/architecture/ux-architecture.md)
- Правила: `rules/security.mdc`, `rules/tenancy-rls.mdc`, `rules/i18n.mdc`
