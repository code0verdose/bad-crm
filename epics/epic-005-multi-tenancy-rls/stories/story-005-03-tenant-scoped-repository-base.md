---
id: STORY-005-03
epic: EPIC-005
status: review
blocked: false
priority: must
estimate: M
---

# STORY-005-03 — База tenant-scoped репозитория и запрет прямых prisma.*

**Как** разработчик Bad CRM **я хочу** единственный способ обращаться к БД — через tenant-scoped
репозиторий **чтобы** `prisma.task.findMany()` не просочился в контроллер и не обошёл контекст
арендатора.

## Acceptance (Given/When/Then)

- [x] **Given** базовый класс/функция репозитория **When** наследник выполняет запрос **Then** он использует транзакцию из ALS; попытка выполнить запрос вне `withTenant` бросает ошибку до обращения к БД. *`infrastructure/persistence/prisma/tenant-scoped.repository.ts`: единственный путь наследника к БД — `run(operation, work)`, который первым делом спрашивает `requireTenant`. Ни один метод не принимает ни транзакцию, ни `organizationId` — вторая точка правды о тенанте не отвергается политикой, а фильтруется, то есть возвращает пустой список вместо ошибки.*
- [x] **Given** файл `src/presentation/http/controllers/*.controller.ts` с вызовом `prisma.` **When** запускается `pnpm lint` **Then** он падает. — сделано в [STORY-001-03](../../epic-001-monorepo-and-dev-env/stories/story-001-03-eslint-prettier-husky-commitlint.md); фикстура и проверка — `test/lint/architecture-rules.test.ts`.
- [x] **Given** файл `src/application/**` с импортом `@prisma/client` **When** запускается линт **Then** он падает. — сделано в [STORY-001-03](../../epic-001-monorepo-and-dev-env/stories/story-001-03-eslint-prettier-husky-commitlint.md).
- [x] **Given** репозиторий, возвращающий Prisma-модель наружу **When** запускается архитектурный тест **Then** он падает: наружу отдаются доменные сущности либо read-модели. *Обеспечено двумя механизмами вместо одного теста: ESLint не пускает `@prisma/client` за пределы `infrastructure/persistence` (тип Prisma физически не может стоять в сигнатуре порта), а `organization-row.util.ts` переводит строку в `OrganizationSummary`; `test/unit/persistence/organization-row.test.ts` проверяет, что маппер перечисляет поля, а не расплёскивает строку спредом.*
- [x] **Given** тестовая реализация порта в памяти **When** выполняется юнит-тест use-case **Then** он не требует БД и не импортирует Prisma. *`test/unit/application/bootstrap-organization.use-case.test.ts` — in-memory реализация всех четырёх портов, включая транзакцию с откатом.*
- [ ] **Given** явный обход RLS (`bypassRls: true`) для системной операции **When** он используется **Then** это фиксируется записью в аудит-журнал и попадает в лог с уровнем `warn`. — **перенесено в [STORY-016-02](../../epic-016-audit-log/stories/story-016-02-audit-logger-port.md)**: `AuditLoggerPort` и таблицы журнала не существует, а обход, который некуда записать, — это обход без следа. Флага `bypassRls` в `TenantContext` намеренно нет: его нельзя добавить раньше журнала, иначе появится путь, которым можно воспользоваться молча.
- [x] **Given** `$queryRawUnsafe` в коде **When** запускается линт **Then** он запрещён. *Правило было с [STORY-001-03](../../epic-001-monorepo-and-dev-env/stories/story-001-03-eslint-prettier-husky-commitlint.md), но фикстуры, доказывающей его срабатывание, не было — правило, снятое из конфига, никто бы не заметил. Добавлена: `test/lint/fixtures/.../infrastructure/persistence/raw-unsafe.repository.ts`, именно в том слое, где сняты все остальные запреты Prisma.*

## Задачи

- [x] Написать тесты первыми: `test/unit/architecture/prisma-boundary.test.ts` (ESLint программно на фикстурах), `test/integration/persistence/tenant-repository.test.ts`, `test/unit/persistence/no-prisma-types-leak.test.ts`. *Фактические файлы: `test/lint/architecture-rules.test.ts` (корневой, уже существовал — ESLint программно на фикстурах, включая новую про `$queryRawUnsafe`), `test/unit/persistence/tenant-scoped-repository.test.ts` (отказ вне скоупа, транзакция из ALS, трансляция ошибок), `test/unit/persistence/organization-repository.test.ts`, `test/unit/persistence/organization-row.test.ts`, `test/integration/db/organization-bootstrap.test.ts` (на реальной БД).*
- [x] Реализовать `infrastructure/persistence/prisma/tenant-repository.base.ts` — доступ к транзакции из ALS, хелперы, обработка `P2002`/`P2025` в доменные ошибки. *Файл называется `tenant-scoped.repository.ts`: суффикс `.base.ts` не входит в закрытый словарь `rules/naming-and-structure.mdc`, и линтер `bad-crm/require-role-suffix` его отвергает. `P2025` переводится не прямым `new NotFoundError`, а через `denyAccess(resource, 'other_organization')` — выбор «404, а не 403» делается в одном месте, и `test/unit/architecture/access-denial.test.ts` это проверяет (первая версия правки как раз на нём и упала).*
- [x] Реализовать маппинг `row ↔ entity` как отдельный модуль на контекст (`*.mapper.ts`), чтобы Prisma-типы не покидали слой. *Файл — `organization-row.util.ts`: суффикса `.mapper.ts` в закрытом словаре тоже нет.*
- [x] Добавить ESLint-правила `no-restricted-imports` (`@prisma/client` вне persistence) и `no-restricted-syntax` (`prisma.` вне persistence, `$queryRawUnsafe` везде). — сделано в [STORY-001-03](../../epic-001-monorepo-and-dev-env/stories/story-001-03-eslint-prettier-husky-commitlint.md); здесь добавлена недостающая фикстура на `$queryRawUnsafe`.
- [x] Реализовать `UnitOfWorkPort` и его Prisma-реализацию поверх `withTenant`; вложенный вызов переиспользует существующую транзакцию. *`application/platform/ports/unit-of-work.port.ts` + `infrastructure/persistence/prisma/unit-of-work.adapter.ts`. Метода `withTransaction` без тенанта в порту нет намеренно: в этой системе транзакция и тенант — одно и то же. Переиспользование вложенного вызова уже обеспечивал `withTenant` (и падает `CrossTenantNestingError` при смене организации).*
- [ ] Реализовать типизированный `bypassRls`-путь с обязательным аргументом «причина» и записью в аудит. — **перенесено в [STORY-016-02](../../epic-016-audit-log/stories/story-016-02-audit-logger-port.md)** вместе с критерием выше.
- [x] Задокументировать в `docs/security/rls-design.md` фактическую реализацию и добавить пункт в чек-лист «новая таблица». *Добавлен раздел «База репозитория: `TenantScopedRepository`» (с таблицей трансляции ошибок) и пункт 9a чек-листа.*

## Definition of Done

- [x] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [x] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [x] Документация обновлена (docs/ + запись в `docs/brain/`)
- [x] a11y-проверка (для UI-историй) — не применимо
- [x] i18n: строки в обоих языках, хардкода нет (для UI-историй) — не применимо

## Ссылки

- Документация: [`rls-design.md` → ESLint: нет прямых `prisma.*`](../../../docs/security/rls-design.md), [`stack.md` → infrastructure — реализации портов](../../../docs/architecture/stack.md)
- Правила: `rules/tenancy-rls.mdc`, `rules/naming-and-structure.mdc`
