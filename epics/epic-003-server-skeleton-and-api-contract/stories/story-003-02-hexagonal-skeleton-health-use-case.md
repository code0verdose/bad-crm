---
id: STORY-003-02
epic: EPIC-003
status: review
blocked: false
priority: must
estimate: M
---

# STORY-003-02 — Гексагональный скелет и сквозной health use-case

**Как** разработчик Bad CRM **я хочу** готовую раскладку слоёв с одним доказанным сквозным
сценарием **чтобы** каждый следующий домен добавлялся по образцу, а направление зависимостей
проверялось автоматически, а не на ревью.

## Acceptance (Given/When/Then)

- **Given** раскладка `domain / application / infrastructure / presentation` **When** запускаю `pnpm lint` и архитектурные тесты **Then** нарушение любого из правил падает: `domain` не импортирует `@prisma/client`, `express`, `ioredis`, `node:fs`; `application` не импортирует `infrastructure`; контроллер не импортирует репозиторий.
- **Given** use-case `CheckHealthUseCase`, зависящий от `HealthProbePort` **When** в юнит-тесте подставлена in-memory реализация порта **Then** тест выполняется без БД, HTTP и контейнеров быстрее 50 мс.
- **Given** `GET /health` **When** я делаю запрос через supertest **Then** ответ 200 и тело формируется сериализатором из результата use-case, а не собирается в контроллере.
- **Given** реализация порта, бросающая ошибку **When** вызывается use-case **Then** он возвращает доменную ошибку, а не Prisma/Redis-исключение: инфраструктурные типы наружу не протекают.
- **Given** попытка объявить интерфейс порта в `infrastructure` **When** запускается архитектурный тест **Then** он падает: порты объявляются в `application/<context>/ports`.
- **Given** файл `list-something.query.ts` **When** он открывает транзакцию на запись **Then** тест соглашений падает: `*.query.ts` только читает, состояние меняет `*.use-case.ts`.
- **Given** новый контекст, созданный по шаблону **When** запускаю генератор/чек структуры **Then** проверяется наличие обязательных каталогов и соответствие имён файлов role-суффиксам.

## Задачи

- [x] Написать тесты первыми: `test/unit/architecture/layers.test.ts` (запрещённые импорты по слоям через анализ AST/зависимостей), `test/unit/architecture/naming.test.ts` (role-суффиксы `*.use-case.ts`, `*.query.ts`, `*.port.ts`, `*.entity.ts`, `*.policy.ts`, `*.repository.ts`, `*.controller.ts`), `application/platform/use-cases/check-health.use-case.test.ts`.
- [x] Создать каркас каталогов `packages/server/src/{domain,application,infrastructure,presentation}` с `domain/shared/{errors,ids,result}`.
- [x] Реализовать `domain/shared/errors/` — `DomainError`, `NotFoundError`, `ForbiddenError`, `ConflictError` с полем `code` из каталога `packages/shared`.
- [x] Реализовать `application/platform/ports/health-probe.port.ts` и `clock.port.ts`, `id-generator.port.ts` (базовые порты, нужные всем контекстам).
- [x] Реализовать `application/platform/use-cases/check-health.use-case.ts` — возвращает статус процесса и версию приложения, без обращений к БД.
- [x] Реализовать адаптеры `infrastructure/platform/process-health.adapter.ts`, `infrastructure/platform/system-clock.adapter.ts`, `infrastructure/platform/ulid-id-generator.adapter.ts`.
- [x] Реализовать `presentation/http/controllers/health.controller.ts`, `presentation/http/serializers/health.serializer.ts`, регистрацию в `routes.ts`.
- [x] Задокументировать шаблон нового контекста в `docs/architecture/` (какие каталоги обязательны, куда что кладётся) и сослаться на него из `rules/naming-and-structure.mdc`.

> **Отклонения от формулировок задач.** Контроллер и сериализатор названы по словарю суффиксов;
> `/ready` реализован через отдельный `check-readiness.use-case.ts` + `ReadinessProbePort`, а не как
> алиас `/health` — полные проверки Postgres/Redis добавляются в EPIC-009 регистрацией пробы в
> `container.factory.ts`. Шаблон контекста задокументирован в
> [`docs/architecture/backend-context-template.md`](../../../docs/architecture/backend-context-template.md).

## Definition of Done

- [x] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [x] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y-проверка (для UI-историй) — не применимо
- [ ] i18n: строки в обоих языках, хардкода нет (для UI-историй) — не применимо

## Ссылки

- Документация: [`stack.md` → Backend: гексагональная архитектура](../../../docs/architecture/stack.md), [`overview.md` → C4 уровень 3 и проверяемые следствия правил](../../../docs/architecture/overview.md), [ADR-0002](../../../docs/architecture/adr/0002-hexagonal-backend-express-prisma.md)
- Правила: `rules/naming-and-structure.mdc`, `rules/testing.mdc`
