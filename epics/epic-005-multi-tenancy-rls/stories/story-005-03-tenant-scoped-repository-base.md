---
id: STORY-005-03
epic: EPIC-005
status: backlog
blocked: false
priority: must
estimate: M
---

# STORY-005-03 — База tenant-scoped репозитория и запрет прямых prisma.*

**Как** разработчик Bad CRM **я хочу** единственный способ обращаться к БД — через tenant-scoped
репозиторий **чтобы** `prisma.task.findMany()` не просочился в контроллер и не обошёл контекст
арендатора.

## Acceptance (Given/When/Then)

- **Given** базовый класс/функция репозитория **When** наследник выполняет запрос **Then** он использует транзакцию из ALS; попытка выполнить запрос вне `withTenant` бросает ошибку до обращения к БД.
- **Given** файл `src/presentation/http/controllers/*.controller.ts` с вызовом `prisma.` **When** запускается `pnpm lint` **Then** он падает с сообщением «прямой доступ к Prisma разрешён только в `infrastructure/persistence`».
- **Given** файл `src/application/**` с импортом `@prisma/client` **When** запускается линт **Then** он падает: `application` знает только свои порты.
- **Given** репозиторий, возвращающий Prisma-модель наружу **When** запускается архитектурный тест **Then** он падает: наружу отдаются доменные сущности либо read-модели, а не типы Prisma.
- **Given** тестовая реализация порта в памяти **When** выполняется юнит-тест use-case **Then** он не требует БД и не импортирует Prisma.
- **Given** явный обход RLS (`bypassRls: true`) для системной операции **When** он используется **Then** это фиксируется записью в аудит-журнал и попадает в лог с уровнем `warn`; использование без записи покрыто падающим тестом.
- **Given** `$queryRawUnsafe` в коде **When** запускается линт **Then** он запрещён; допустим только параметризованный `$queryRaw` внутри persistence с комментарием-обоснованием.

## Задачи

- [ ] Написать тесты первыми: `test/unit/architecture/prisma-boundary.test.ts` (ESLint программно на фикстурах), `test/integration/persistence/tenant-repository.test.ts` (запрос вне контекста падает; запрос в контексте видит только свои строки), `test/unit/persistence/no-prisma-types-leak.test.ts`.
- [ ] Реализовать `infrastructure/persistence/prisma/tenant-repository.base.ts` — доступ к транзакции из ALS, хелперы `findOwn`, `saveOwn`, обработка `P2002`/`P2025` в доменные ошибки.
- [ ] Реализовать маппинг `row ↔ entity` как отдельный модуль на контекст (`*.mapper.ts`), чтобы Prisma-типы не покидали слой.
- [ ] Добавить ESLint-правила `no-restricted-imports` (`@prisma/client` вне persistence) и `no-restricted-syntax` (`prisma.` вне persistence, `$queryRawUnsafe` везде).
- [ ] Реализовать `UnitOfWorkPort` и его Prisma-реализацию поверх `withTenant`; вложенный вызов переиспользует существующую транзакцию.
- [ ] Реализовать типизированный `bypassRls`-путь с обязательным аргументом «причина» и записью в аудит (заготовка `AuditLoggerPort` из [EPIC-009](../../epic-009-observability/epic.md)).
- [ ] Задокументировать в `docs/security/rls-design.md` фактическую реализацию (если отличается) и добавить пункт в чек-лист «новая таблица».

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y-проверка (для UI-историй) — не применимо
- [ ] i18n: строки в обоих языках, хардкода нет (для UI-историй) — не применимо

## Ссылки

- Документация: [`rls-design.md` → ESLint: нет прямых `prisma.*`](../../../docs/security/rls-design.md), [`stack.md` → infrastructure — реализации портов](../../../docs/architecture/stack.md)
- Правила: `rules/tenancy-rls.mdc`, `rules/naming-and-structure.mdc`
