---
id: STORY-005-02
epic: EPIC-005
status: review
blocked: false
priority: must
estimate: L
---

# STORY-005-02 — RLS-политики и выставление контекста через set_config

**Как** владелец инсталляции **я хочу** чтобы изоляция организаций держалась на PostgreSQL, а не на
аккуратности разработчика **чтобы** забытый `WHERE` не превращался в утечку данных заказчика к
другому арендатору.

## Acceptance (Given/When/Then)

- [x] **Given** таблица с `organization_id` **When** применена её миграция **Then** в каталоге БД присутствуют: `relrowsecurity = true`, `relforcerowsecurity = true`, политика `tenant_isolation` для роли `app_user` с непустыми `USING` и `WITH CHECK`, политика `maintenance_access` для `app_migrator`, явные `GRANT` для `app_user`. — сделано в [STORY-003-06](../../epic-003-server-skeleton-and-api-contract/stories/story-003-06-prisma-init-and-testcontainers-harness.md). *Проверяется чтением каталога, а не поведением: `test/integration/db/migrations.test.ts` сверяет `pg_class.relrowsecurity`/`relforcerowsecurity` и `pg_get_expr(polqual|polwithcheck)` с каноническим шаблоном. Это единственный способ доказать наличие `WITH CHECK`: в политике `FOR ALL` PostgreSQL подставляет `USING`, поэтому её отсутствие не роняет ни одного поведенческого теста.*
- [x] **Given** установленный контекст организации A **When** выполняется `SELECT` строки организации B по её `id` **Then** возвращается 0 строк — не ошибка, не данные. — сделано в [STORY-003-06](../../epic-003-server-skeleton-and-api-contract/stories/story-003-06-prisma-init-and-testcontainers-harness.md).
- [x] **Given** установленный контекст организации A **When** выполняется `INSERT` со значением `organization_id` организации B **Then** запрос отклоняется нарушением `WITH CHECK`. — сделано в [STORY-003-06](../../epic-003-server-skeleton-and-api-contract/stories/story-003-06-prisma-init-and-testcontainers-harness.md).
- [x] **Given** установленный контекст организации A **When** выполняется `UPDATE`, меняющий `organization_id` своей строки на организацию B **Then** запрос отклоняется `WITH CHECK`. — сделано в [STORY-003-06](../../epic-003-server-skeleton-and-api-contract/stories/story-003-06-prisma-init-and-testcontainers-harness.md).
- [x] **Given** транзакция, где выполнен `set_config('app.organization_id', …, true)` **When** транзакция завершается и соединение возвращается в пул **Then** следующий запрос из пула не видит прежнего значения GUC. — сделано в [STORY-003-06](../../epic-003-server-skeleton-and-api-contract/stories/story-003-06-prisma-init-and-testcontainers-harness.md) (`test/integration/db/tenant-context.test.ts` → «leaves no context on the connection once the transaction is over»).
- [x] **Given** запрос вне транзакции с контекстом **When** политика не находит `app.organization_id` **Then** он не возвращает ни одной строки и/или падает. — сделано в [STORY-003-06](../../epic-003-server-skeleton-and-api-contract/stories/story-003-06-prisma-init-and-testcontainers-harness.md). *Реализация строже формулировки: падает всегда (`42704`/`22P02`), «пусто» невозможно — в предикате стоит однааргументный `current_setting`, а не «мягкая» форма.*
- [x] **Given** новая PERMISSIVE-политика с неканоническим предикатом, добавленная на мультиарендную таблицу **When** запускается структурный CI-чек **Then** он падает. — сделано в [STORY-003-06](../../epic-003-server-skeleton-and-api-contract/stories/story-003-06-prisma-init-and-testcontainers-harness.md) (`migrations.test.ts` → «has no permissive policy that widens app_user»).
- [x] **Given** таблица с `organization_id`, добавленная без блока RLS **When** запускается миграционный чек по каталогу БД **Then** сборка падает с именем таблицы и перечнем недостающих элементов. — сделано в [STORY-003-06](../../epic-003-server-skeleton-and-api-contract/stories/story-003-06-prisma-init-and-testcontainers-harness.md). *Механизм другой, чем в задаче ниже: не отдельный скрипт, а связка `tenant-tables.test.ts` (реестр ↔ Prisma-схема, обе стороны) + `migrations.test.ts` (реестр ↔ каталог БД) + `ROW_FACTORIES` как `satisfies` (таблица без фабрики не компилируется). Имя таблицы в сообщении есть — оно в имени параметризованного теста.*

## Задачи

- [x] Написать тесты первыми (Testcontainers): `test/integration/rls/policy-shape.test.ts`, `test/integration/rls/set-config.test.ts`, `test/integration/rls/with-check.test.ts`. — сделано в [STORY-003-06](../../epic-003-server-skeleton-and-api-contract/stories/story-003-06-prisma-init-and-testcontainers-harness.md). *Разложены иначе: каталог `test/integration/db/`, три файла вместо трёх — `migrations.test.ts` (форма политик и гранты), `tenant-context.test.ts` (локальность GUC, переиспользование соединения), `rls-isolation.test.ts` (`WITH CHECK` на вставке и на «переезде» строки).*
- [x] Реализовать шаблон миграции с пятью обязательными блоками (`ENABLE`, `FORCE`, `tenant_isolation`, `maintenance_access`, `GRANT`) и генератор/сниппет для его вставки. — сделано в [STORY-003-06](../../epic-003-server-skeleton-and-api-contract/stories/story-003-06-prisma-init-and-testcontainers-harness.md): шаблон — сама первая миграция плюс чек-лист «новая таблица» в [`rls-design.md`](../../../docs/security/rls-design.md). *Генератор не написан и не планируется: пять блоков копируются из чек-листа, а генератор был бы четвёртым местом, где живёт шаблон.*
- [x] Реализовать `infrastructure/persistence/prisma/tenant-client.ts`: `withTenant(base, ctx, fn)`. — сделано в [STORY-003-06](../../epic-003-server-skeleton-and-api-contract/stories/story-003-06-prisma-init-and-testcontainers-harness.md); файл называется `tenant.context.ts`.
- [x] Реализовать `guardedClient(base)` через `$extends`. — сделано в [STORY-003-06](../../epic-003-server-skeleton-and-api-contract/stories/story-003-06-prisma-init-and-testcontainers-harness.md).
- [x] Реализовать особый случай политики для `organizations` (предикат по собственному `id`). — сделано в [STORY-003-06](../../epic-003-server-skeleton-and-api-contract/stories/story-003-06-prisma-init-and-testcontainers-harness.md).
- [ ] Реализовать раздельные политики по командам для append-only журналов (без `UPDATE`/`DELETE`). — **перенесено в [STORY-016-01](../../epic-016-audit-log/stories/story-016-01-append-only-table.md)**: журнальных таблиц ещё нет. Правило уже действует авансом в `01-grants.sql` (список `append_only`), чтобы журнал не мог приехать с `DELETE` по умолчанию.
- [x] Реализовать `scripts/rls-catalog-check.ts` — сверка списка таблиц с `organization_id` против каталога политик; ненулевой код при расхождении; подключить в CI. — сделано как `packages/server/scripts/check-rls.ts` (`pnpm check:rls`), имя взято из правил, которые его уже называли. *Открытый вопрос закрыт: нужны оба механизма, и это не дублирование ролей. Интеграционный тест поднимает контейнер и судит миграцию **этого чекаута** — он и остаётся проверкой в CI; скрипт подключается к **уже существующей** базе (staging после восстановления из бэкапа, `rls-design.md` → «Проверка политики на снапшоте прод-объёма», шаг 3), куда контейнер не поставишь. Дублированием был бы второй канонический шаблон — его нет: предикат и запросы живут в `src/infrastructure/persistence/prisma/rls-catalog.constant.ts`, обоими консьюмерами читаются оттуда, а `test/unit/persistence/rls-catalog-sources.test.ts` падает, если идентификатор каталога появится ещё где-нибудь под `src/`, `test/` или `scripts/`.* В turbo-набор `check:rls` **не** заведён осознанно: `inputs` там allow-list по файлам, а состояние чужой БД в хеш не входит — кешированный PASS над непроверенной базой был бы ровно тем дефектом, который скрипт должен ловить.
- [x] Настроить `statement_timeout`, `idle_in_transaction_session_timeout`, `lock_timeout` на ролях. — сделано в [STORY-001-04](../../epic-001-monorepo-and-dev-env/stories/story-001-04-docker-compose-dev-services.md) (`prisma/sql/00-bootstrap-roles.sql`).
- [x] Добавить `grep`-чек: в кодовой базе нет `SET` без `LOCAL` для наших GUC и нет `set_config` с `is_local = false`. — сделано в [EPIC-002](../../epic-002-ci-and-commit-gate/epic.md); исключение сужено до одной строки и проверяется `test/repo/runbook-restore.test.ts`.

## Definition of Done

- [x] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [x] Commit-гейт зелёный (test-coverage, security-auditor, **db-reviewer обязателен**, production-readiness, commit-hygiene)
- [x] Документация обновлена (docs/ + запись в `docs/brain/`)
- [x] a11y-проверка (для UI-историй) — не применимо
- [x] i18n: строки в обоих языках, хардкода нет (для UI-историй) — не применимо

## Ссылки

- Документация: [`rls-design.md` → Канонический шаблон политики, Ловушки, Автоматизация](../../../docs/security/rls-design.md), [`data-model.md` → Шаблон политики](../../../docs/architecture/data-model.md), [ADR-0004](../../../docs/architecture/adr/0004-multi-tenancy-postgres-rls.md)
- Правила: `rules/tenancy-rls.mdc`, `rules/security.mdc`
