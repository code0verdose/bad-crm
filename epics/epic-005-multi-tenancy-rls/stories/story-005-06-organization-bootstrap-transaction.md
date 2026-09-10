---
id: STORY-005-06
epic: EPIC-005
status: review
blocked: false
priority: must
estimate: M
---

# STORY-005-06 — Bootstrap организации и первого владельца в одной транзакции

**Как** владелец инсталляции **я хочу** чтобы создание организации и её первого владельца было
атомарным **чтобы** после сбоя не оставалось организации, в которую невозможно войти, или
пользователя без арендатора.

## Acceptance (Given/When/Then)

- [x] **Given** запрос на создание организации с данными владельца **When** он выполняется успешно **Then** в одной транзакции создаются `Organization`, `User`, системные роли организации и назначение владельцу роли `owner`; возвращается идентификатор организации. *`BootstrapOrganizationUseCase` создаёт все три через порты в одном `withTenant`. Порты (`UserRepositoryPort`, `RoleSeederPort`) объявлены здесь, потому что порт определяется потребителем. *Уточнено 2026-08-30: оговорка «Prisma-адаптеры есть только у организации, таблиц `users` и `roles` не существует» устарела — обе таблицы созданы миграциями `20260728120000_auth_core_identity_and_sessions` и `20260805100000_roles`, адаптеры на месте, и организация с владельцем пишется одним оператором (`OrganizationRepositoryPort.createWithOwner`).*
- [x] **Given** сбой на шаге создания пользователя **When** транзакция откатывается **Then** организации в БД не остаётся; повторный запрос с корректными данными проходит. *Проверено дважды: юнит-тестом на in-memory транзакции (по одному падению на каждый шаг) и на живой БД — `test/integration/db/organization-bootstrap.test.ts` → «leaves no organization behind when a later step fails».*
- [x] **Given** занятый `slug` организации **When** выполняется bootstrap **Then** возвращается 409 `organization_already_exists`, и ни одна строка не создана. *На живой БД. Отдельно стоит отметить, **почему** это может быть обнаружено только уникальным индексом: `slug` глобально уникален, но `SELECT … WHERE slug = $1` под политикой ещё не существующей организации всегда пуст — предварительной проверки не существует в принципе.*
- [x] **Given** bootstrap **When** он выполняется **Then** он работает по особому пути: контекст арендатора устанавливается для организации, которой ещё нет. *Формулировка исправлена: в исходном тексте было «контекст устанавливается **внутри** транзакции сразу после вставки организации» — так не получится, `WITH CHECK (id = current_setting('app.organization_id')::uuid)` требует контекст **до** вставки, иначе `current_setting` бросит ошибку на первом же операторе. Реализован второй из двух вариантов, которые допускала сама задача ниже: приложение генерирует `uuid` **до** транзакции и открывает скоуп как эта организация. `SECURITY DEFINER`-функция не понадобилась — то есть путь не создаёт ни одной новой поверхности с `BYPASSRLS`. Ровно этот же порядок описан в [`rls-design.md`](../../../docs/security/rls-design.md), «Особый случай: `organizations`».*
- [x] **Given** созданная организация **When** проверяю её данные под контекстом другой организации **Then** она невидима. *И обратное, что важнее: **через сам bootstrap-путь** чужая организация недоступна — ни на чтение, ни на запись. Оба утверждения на живой БД, с положительным контролем «чужая организация всё это время существует» (`countOrganizations() === 2`).*
- [ ] **Given** повторный вызов bootstrap с тем же `Idempotency-Key` **When** он выполняется **Then** возвращается сохранённый ответ, вторая организация не создаётся. — **перенесено в [STORY-006-01](../../epic-006-auth-core/stories/story-006-01-organization-and-owner-registration.md)**; причина уточнена 2026-08-30: HTTP-вход появился, и заголовок **обязателен** (`presentation/http/middleware/idempotency-key.middleware.ts`), но таблицы `(ключ, хеш запроса) → ответ` по-прежнему нет, поэтому повтор получает `409 organization_already_exists` вместо сохранённого `201`. Безопасная половина закрыта глобально уникальным `slug`, отсутствует только удобство.
- [x] **Given** успешный bootstrap **When** смотрю аудит **Then** записано событие создания организации с актором и IP. — **закрыто 2026-09-10** (запись появилась с журналом 2026-08-30, но стояла во **второй**, сессионной транзакции; внутрь транзакции создания её перенёс `c826ea3`): `application/identity/use-cases/register-organization.use-case.ts` пишет `organization.registered` с `actor.userId`, `actor.organizationId` и `actor.ipAddress` **внутри** той же транзакции; адрес хешируется писателем и сырым не хранится. Запись стоит в сценарии регистрации, а не в самом bootstrap-use-case'е: IP знает транспортный слой, и это по-прежнему единственный вызывающий, у которого он есть.
- [x] **Given** созданная организация **When** смотрю её настройки **Then** заданы дефолты: язык, часовой пояс, валюта. *Часовой пояс и валюта — да (в `OrganizationDraft`, с дефолтами колонки `UTC`/`USD`). **Языка в модели нет:** [`data-model.md`](../../../docs/architecture/data-model.md) держит `locale` на `User`, у `Organization` его нет; расхождение в тексте истории, а не в схеме.*

## Задачи

- [x] Написать тесты первыми: `bootstrap-organization.use-case.test.ts` (успех, откат при сбое на каждом шаге, конфликт slug), `test/integration/db/organization-bootstrap.test.ts` (атомарность на реальной БД, изоляция созданной организации, идемпотентность). *Файлы: `test/unit/application/bootstrap-organization.use-case.test.ts` (7 тестов, все порты — in-memory, транзакция с настоящим откатом, а не мок) и `test/integration/db/organization-bootstrap.test.ts` (6 тестов). Идемпотентность — вместе с `Idempotency-Key`, см. перенесённый критерий.*
- [x] Реализовать `application/organization/use-cases/bootstrap-organization.use-case.ts` с портами `OrganizationRepositoryPort`, `UserRepositoryPort`, `RoleSeederPort`, `UnitOfWorkPort`, `ClockPort`, `IdGeneratorPort`. *Все, кроме `ClockPort`: ни одного поля времени use-case не проставляет — `created_at`/`updated_at` заполняет БД и Prisma. Порт без вызова был бы аргументом, который никто не читает. В `IdGeneratorPort` добавлен метод `uuid()`: `next()` отдаёт ULID, а все ключи в модели — `uuid`, и ULID в такой колонке — это `22P02` в конце транзакции, уже что-то записавшей.*
- [x] Реализовать особый транзакционный путь. *См. исправленную формулировку критерия выше: `uuid` генерируется до транзакции, скоуп открывается как будущая организация, `SECURITY DEFINER` не используется.*
- [x] Реализовать сидирование системных ролей организации (`owner`, `admin`, `member`, `viewer`) как часть той же транзакции. *Как порт `RoleSeederPort` с ключами ролей; наполнение прав и Prisma-адаптер — [EPIC-011](../../epic-011-rbac-permissions/epic.md), таблица `roles` — [STORY-006-01](../../epic-006-auth-core/stories/story-006-01-organization-and-owner-registration.md).*
- [ ] Реализовать поддержку `Idempotency-Key` для операции создания организации (таблица `idempotency_key`). — **перенесено в [STORY-006-01](../../epic-006-auth-core/stories/story-006-01-organization-and-owner-registration.md)**; там же и осталось открытым — принимающая половина сделана, хранилище ответов нет (см. критерий выше).
- [x] Реализовать контроллер и описать операцию в `docs/api/openapi.yaml`. — переносилось в [STORY-006-01](../../epic-006-auth-core/stories/story-006-01-organization-and-owner-registration.md), **приехало и закрыто 2026-08-30**: `docs/api/openapi.yaml:80` (`/auth/register`), `presentation/http/controllers/auth.controller.ts` + `validators/auth.validator.ts`.
- [x] Добавить негативные тесты: попытка bootstrap при уже существующем пользователе с тем же email в той же организации. — **закрыто 2026-08-30 в той форме, в которой продукт это допускает.** Уникальность держит частичный индекс `uq_users_org_email` (`prisma/migrations/20260728120000_auth_core_identity_and_sessions/migration.sql:120`), отказ — `user_already_exists`, и он проверен на живом стеке там, где второй пользователь в одной организации вообще появляется: `test/integration/http/invitation-endpoints.test.ts:122`. Через сам bootstrap случай недостижим — организация каждый раз новая, и второго адреса в ней нет.

## Definition of Done

- [x] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [x] Commit-гейт зелёный (test-coverage, security-auditor, **db-reviewer обязателен**, production-readiness, commit-hygiene)
- [x] Документация обновлена (docs/ + запись в `docs/brain/`)
- [x] a11y-проверка (для UI-историй) — не применимо
- [x] i18n: строки в обоих языках, хардкода нет (для UI-историй) — ошибки возвращаются кодами

## Ссылки

- Документация: [`rls-design.md` → Особые пути (путь 1: логин/организация ещё не известна)](../../../docs/security/rls-design.md), [`data-model.md` → Tenancy и идентичность](../../../docs/architecture/data-model.md), [`stack.md` → Идемпотентность](../../../docs/architecture/stack.md)
- Правила: `rules/tenancy-rls.mdc`, `rules/api-contract.mdc`
