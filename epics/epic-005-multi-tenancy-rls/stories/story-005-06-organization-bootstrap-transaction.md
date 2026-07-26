---
id: STORY-005-06
epic: EPIC-005
status: backlog
blocked: false
priority: must
estimate: M
---

# STORY-005-06 — Bootstrap организации и первого владельца в одной транзакции

**Как** владелец инсталляции **я хочу** чтобы создание организации и её первого владельца было
атомарным **чтобы** после сбоя не оставалось организации, в которую невозможно войти, или
пользователя без арендатора.

## Acceptance (Given/When/Then)

- **Given** запрос на создание организации с данными владельца **When** он выполняется успешно **Then** в одной транзакции создаются `Organization`, `User` со статусом `ACTIVE`, системные роли организации и назначение владельцу роли `owner`; возвращается идентификатор организации.
- **Given** сбой на шаге создания пользователя (например, конфликт email) **When** транзакция откатывается **Then** организации в БД не остаётся; повторный запрос с корректными данными проходит.
- **Given** занятый `slug` организации **When** выполняется bootstrap **Then** возвращается 409 `organization_already_exists`, и ни одна строка не создана.
- **Given** bootstrap **When** он выполняется **Then** он работает по особому пути: `organizationId` ещё неизвестен на входе, поэтому контекст арендатора устанавливается **внутри** транзакции сразу после вставки организации, а не берётся из сессии.
- **Given** созданная организация **When** проверяю её данные под контекстом другой организации **Then** она невидима — политика `organizations` по собственному `id` работает.
- **Given** повторный вызов bootstrap с тем же `Idempotency-Key` и тем же телом **When** он выполняется **Then** возвращается сохранённый ответ, вторая организация не создаётся.
- **Given** успешный bootstrap **When** смотрю аудит **Then** записано событие создания организации с актором и IP (заготовка журнала — [EPIC-009](../../epic-009-observability/epic.md), полноценно — [EPIC-016](../../epic-016-audit-log/epic.md)).
- **Given** созданная организация **When** смотрю её настройки **Then** заданы дефолты: язык, часовой пояс, валюта — из входных данных или из значений по умолчанию инсталляции.

## Задачи

- [ ] Написать тесты первыми: `application/organization/use-cases/bootstrap-organization.use-case.test.ts` (успех, откат при сбое на каждом шаге, конфликт slug), `test/integration/organization/bootstrap.test.ts` (атомарность на реальной БД, изоляция созданной организации, идемпотентность).
- [ ] Реализовать `application/organization/use-cases/bootstrap-organization.use-case.ts` с портами `OrganizationRepositoryPort`, `UserRepositoryPort`, `RoleSeederPort`, `UnitOfWorkPort`, `ClockPort`, `IdGeneratorPort`.
- [ ] Реализовать особый транзакционный путь: открыть транзакцию под `app_user`, вставить организацию через `SECURITY DEFINER`-функцию или под контекстом свеже-сгенерированного `organizationId`, затем `set_config` и продолжить остальные вставки (реализация по разделу «Особые пути» в [`rls-design.md`](../../../docs/security/rls-design.md)).
- [ ] Реализовать сидирование системных ролей организации (`owner`, `admin`, `member`, `viewer`) как часть той же транзакции; наполнение прав — [EPIC-011](../../epic-011-rbac-permissions/epic.md).
- [ ] Реализовать поддержку `Idempotency-Key` для операции создания организации (таблица `idempotency_key`).
- [ ] Реализовать контроллер и описать операцию в `docs/api/openapi.yaml` (реальный HTTP-вход появляется в [STORY-006-01](../../epic-006-auth-core/stories/story-006-01-organization-and-owner-registration.md); здесь — use-case и порт).
- [ ] Добавить негативные тесты: попытка bootstrap при уже существующем пользователе с тем же email в той же организации.

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, **db-reviewer обязателен**, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y-проверка (для UI-историй) — не применимо
- [ ] i18n: строки в обоих языках, хардкода нет (для UI-историй) — ошибки возвращаются кодами

## Ссылки

- Документация: [`rls-design.md` → Особые пути (путь 1: логин/организация ещё не известна)](../../../docs/security/rls-design.md), [`data-model.md` → Tenancy и идентичность](../../../docs/architecture/data-model.md), [`stack.md` → Идемпотентность](../../../docs/architecture/stack.md)
- Правила: `rules/tenancy-rls.mdc`, `rules/api-contract.mdc`
