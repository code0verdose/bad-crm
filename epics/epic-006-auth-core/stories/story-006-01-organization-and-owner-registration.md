---
id: STORY-006-01
epic: EPIC-006
status: backlog
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
- [ ] Реализовать `packages/shared/src/validation/password.schema.ts` — единая политика пароля для клиента и сервера.
- [ ] Добавить модели `User` и `Session` в `schema.prisma` и миграцию с полным блоком RLS и индексами (`uq_users_org_email … WHERE deleted_at IS NULL`, `idx_users_org_status`).
- [ ] Реализовать `infrastructure/crypto/argon2-password-hasher.adapter.ts` под портом `PasswordHasherPort` (хеш, проверка, признак необходимости перехеша).
- [ ] Реализовать `application/identity/use-cases/register-organization.use-case.ts` поверх bootstrap-сценария из [STORY-005-06](../../epic-005-multi-tenancy-rls/stories/story-005-06-organization-bootstrap-transaction.md).
- [ ] Добавить операцию `POST /api/v1/auth/register` в `docs/api/openapi.yaml` и реализовать контроллер с валидатором.
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
