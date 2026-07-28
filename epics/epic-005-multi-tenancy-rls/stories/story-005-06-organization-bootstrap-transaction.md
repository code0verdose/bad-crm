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

- [x] **Given** запрос на создание организации с данными владельца **When** он выполняется успешно **Then** в одной транзакции создаются `Organization`, `User`, системные роли организации и назначение владельцу роли `owner`; возвращается идентификатор организации. *`BootstrapOrganizationUseCase` создаёт все три через порты в одном `withTenant`. **Prisma-адаптеры есть только у организации:** таблицы `users` и `roles` не существует — их создаёт [STORY-006-01](../../epic-006-auth-core/stories/story-006-01-organization-and-owner-registration.md), которая эту же историю и называет своей основой. Порты (`UserRepositoryPort`, `RoleSeederPort`) объявлены здесь, потому что порт определяется потребителем; их реализации приезжают вместе с таблицами.*
- [x] **Given** сбой на шаге создания пользователя **When** транзакция откатывается **Then** организации в БД не остаётся; повторный запрос с корректными данными проходит. *Проверено дважды: юнит-тестом на in-memory транзакции (по одному падению на каждый шаг) и на живой БД — `test/integration/db/organization-bootstrap.test.ts` → «leaves no organization behind when a later step fails».*
- [x] **Given** занятый `slug` организации **When** выполняется bootstrap **Then** возвращается 409 `organization_already_exists`, и ни одна строка не создана. *На живой БД. Отдельно стоит отметить, **почему** это может быть обнаружено только уникальным индексом: `slug` глобально уникален, но `SELECT … WHERE slug = $1` под политикой ещё не существующей организации всегда пуст — предварительной проверки не существует в принципе.*
- [x] **Given** bootstrap **When** он выполняется **Then** он работает по особому пути: контекст арендатора устанавливается для организации, которой ещё нет. *Формулировка исправлена: в исходном тексте было «контекст устанавливается **внутри** транзакции сразу после вставки организации» — так не получится, `WITH CHECK (id = current_setting('app.organization_id')::uuid)` требует контекст **до** вставки, иначе `current_setting` бросит ошибку на первом же операторе. Реализован второй из двух вариантов, которые допускала сама задача ниже: приложение генерирует `uuid` **до** транзакции и открывает скоуп как эта организация. `SECURITY DEFINER`-функция не понадобилась — то есть путь не создаёт ни одной новой поверхности с `BYPASSRLS`. Ровно этот же порядок описан в [`rls-design.md`](../../../docs/security/rls-design.md), «Особый случай: `organizations`».*
- [x] **Given** созданная организация **When** проверяю её данные под контекстом другой организации **Then** она невидима. *И обратное, что важнее: **через сам bootstrap-путь** чужая организация недоступна — ни на чтение, ни на запись. Оба утверждения на живой БД, с положительным контролем «чужая организация всё это время существует» (`countOrganizations() === 2`).*
- [ ] **Given** повторный вызов bootstrap с тем же `Idempotency-Key` **When** он выполняется **Then** возвращается сохранённый ответ, вторая организация не создаётся. — **перенесено в [STORY-006-01](../../epic-006-auth-core/stories/story-006-01-organization-and-owner-registration.md)**: `Idempotency-Key` — свойство HTTP-входа, а его здесь нет; таблицы `idempotency_key` тоже. Ключ, который негде принять и негде сохранить, реализовать нельзя.
- [ ] **Given** успешный bootstrap **When** смотрю аудит **Then** записано событие создания организации с актором и IP. — **перенесено в [STORY-016-02](../../epic-016-audit-log/stories/story-016-02-audit-logger-port.md)**: `AuditLoggerPort` и таблицы журнала нет. IP — тем более: он известен транспортному слою, которого у этого use-case пока не существует.
- [x] **Given** созданная организация **When** смотрю её настройки **Then** заданы дефолты: язык, часовой пояс, валюта. *Часовой пояс и валюта — да (в `OrganizationDraft`, с дефолтами колонки `UTC`/`USD`). **Языка в модели нет:** [`data-model.md`](../../../docs/architecture/data-model.md) держит `locale` на `User`, у `Organization` его нет; расхождение в тексте истории, а не в схеме.*

## Задачи

- [x] Написать тесты первыми: `bootstrap-organization.use-case.test.ts` (успех, откат при сбое на каждом шаге, конфликт slug), `test/integration/organization/bootstrap.test.ts` (атомарность на реальной БД, изоляция созданной организации, идемпотентность). *Файлы: `test/unit/application/bootstrap-organization.use-case.test.ts` (7 тестов, все порты — in-memory, транзакция с настоящим откатом, а не мок) и `test/integration/db/organization-bootstrap.test.ts` (6 тестов). Идемпотентность — вместе с `Idempotency-Key`, см. перенесённый критерий.*
- [x] Реализовать `application/organization/use-cases/bootstrap-organization.use-case.ts` с портами `OrganizationRepositoryPort`, `UserRepositoryPort`, `RoleSeederPort`, `UnitOfWorkPort`, `ClockPort`, `IdGeneratorPort`. *Все, кроме `ClockPort`: ни одного поля времени use-case не проставляет — `created_at`/`updated_at` заполняет БД и Prisma. Порт без вызова был бы аргументом, который никто не читает. В `IdGeneratorPort` добавлен метод `uuid()`: `next()` отдаёт ULID, а все ключи в модели — `uuid`, и ULID в такой колонке — это `22P02` в конце транзакции, уже что-то записавшей.*
- [x] Реализовать особый транзакционный путь. *См. исправленную формулировку критерия выше: `uuid` генерируется до транзакции, скоуп открывается как будущая организация, `SECURITY DEFINER` не используется.*
- [x] Реализовать сидирование системных ролей организации (`owner`, `admin`, `member`, `viewer`) как часть той же транзакции. *Как порт `RoleSeederPort` с ключами ролей; наполнение прав и Prisma-адаптер — [EPIC-011](../../epic-011-rbac-permissions/epic.md), таблица `roles` — [STORY-006-01](../../epic-006-auth-core/stories/story-006-01-organization-and-owner-registration.md).*
- [ ] Реализовать поддержку `Idempotency-Key` для операции создания организации (таблица `idempotency_key`). — **перенесено в [STORY-006-01](../../epic-006-auth-core/stories/story-006-01-organization-and-owner-registration.md)**.
- [ ] Реализовать контроллер и описать операцию в `docs/api/openapi.yaml`. — **перенесено в [STORY-006-01](../../epic-006-auth-core/stories/story-006-01-organization-and-owner-registration.md)**; сама формулировка задачи это и предполагала («здесь — use-case и порт»).
- [ ] Добавить негативные тесты: попытка bootstrap при уже существующем пользователе с тем же email в той же организации. — **перенесено в [STORY-006-01](../../epic-006-auth-core/stories/story-006-01-organization-and-owner-registration.md)**: уникальность `(organization_id, email)` — свойство таблицы `users`, которой нет. Форма отказа уже определена: `P2002` от любого репозитория превращается в `<resource>_already_exists`.

## Definition of Done

- [x] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [x] Commit-гейт зелёный (test-coverage, security-auditor, **db-reviewer обязателен**, production-readiness, commit-hygiene)
- [x] Документация обновлена (docs/ + запись в `docs/brain/`)
- [x] a11y-проверка (для UI-историй) — не применимо
- [x] i18n: строки в обоих языках, хардкода нет (для UI-историй) — ошибки возвращаются кодами

## Ссылки

- Документация: [`rls-design.md` → Особые пути (путь 1: логин/организация ещё не известна)](../../../docs/security/rls-design.md), [`data-model.md` → Tenancy и идентичность](../../../docs/architecture/data-model.md), [`stack.md` → Идемпотентность](../../../docs/architecture/stack.md)
- Правила: `rules/tenancy-rls.mdc`, `rules/api-contract.mdc`
