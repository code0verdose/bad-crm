---
id: STORY-001-07
epic: EPIC-001
status: backlog
blocked: false
priority: must
estimate: S
---

# STORY-001-07 — packages/shared: типы, Zod-примитивы, каталог permissions

**Как** разработчик Bad CRM **я хочу** изоморфный пакет с общими типами, Zod-примитивами и кодами
ошибок **чтобы** клиент и сервер описывали одни и те же понятия одним кодом, а не двумя
расходящимися копиями.

## Acceptance (Given/When/Then)

- **Given** `packages/shared` **When** импортирую его из `server` и из `client` **Then** сборка обоих проходит: пакет собран в ESM + `.d.ts`, экспорты объявлены через `exports` в `package.json`.
- **Given** branded-тип `OrganizationId` **When** передаю в функцию, ожидающую `UserId`, обычную строку или `OrganizationId` **Then** первые два случая — ошибка компиляции, третий — успех.
- **Given** Zod-примитив `emailSchema` **When** валидирую `"  User@Example.COM "` **Then** `safeParse` успешен и возвращает нормализованное `user@example.com` (`trim` + `toLowerCase` через `.transform`).
- **Given** каталог кодов ошибок `errors/codes.ts` **When** обращаюсь к неизвестному коду **Then** это ошибка компиляции: коды объявлены как union, а не как произвольные строки.
- **Given** заготовка каталога permissions **When** объявляю ключ в формате, отличном от `<resource>:<action>` **Then** тест формата падает: все ключи обязаны соответствовать регулярному выражению и быть уникальными.
- **Given** `packages/shared` **When** прогоняю тест изоморфности **Then** ни одного импорта `node:*` и ни одного обращения к `window`/`document` — пакет работает в обоих рантаймах.
- **Given** денежный примитив **When** создаю сумму из дробного числа **Then** конструктор отвергает значение: деньги хранятся целым числом минорных единиц вместе с кодом валюты.

## Задачи

- [ ] Написать тесты первыми: `src/ids/ids.test.ts` (branded-типы, генерация и парсинг), `src/validation/primitives.test.ts` (email, slug, пагинация, деньги, ISO-даты), `src/errors/codes.test.ts` (уникальность и формат), `src/permissions/catalog.test.ts` (формат `<resource>:<action>`, уникальность ключей, непустое описание).
- [ ] Реализовать `packages/shared/src/ids/` — branded-типы `OrganizationId`, `UserId`, `ProjectId`, `TaskId` + фабрики `asOrganizationId` с рантайм-проверкой UUID.
- [ ] Реализовать `packages/shared/src/validation/` — `email.schema.ts`, `slug.schema.ts`, `money.schema.ts`, `pagination.schema.ts` (offset и cursor варианты), `iso-date.schema.ts`; экспорт через barrel.
- [ ] Реализовать `packages/shared/src/errors/codes.ts` — каталог стабильных машинных кодов (`validation_failed`, `unauthenticated`, `rate_limited`, `stale_version`, `internal_error`, `feature_disabled`, шаблоны `<resource>_not_found` / `<resource>_forbidden`) как union + карта HTTP-статусов.
- [ ] Реализовать `packages/shared/src/permissions/catalog.ts` — заготовка каталога permissions (структура записи: `key`, `resource`, `action`, `category`, `isDangerous`, `descriptionKey`), пока с минимальным набором ключей `organization:read`, `organization:update`. Полное наполнение — [EPIC-011](../../epic-011-rbac-permissions/epic.md).
- [ ] Реализовать `packages/shared/src/result/` — `Result<T, E>` и хелперы, используемые доменом сервера.
- [ ] Настроить сборку пакета (`tsc` → `dist`), поле `exports` с подпутями (`./validation`, `./errors`, `./permissions`, `./ids`), `sideEffects: false`.
- [ ] Зафиксировать в `docs/product/glossary.md` соответствие имён примитивов ubiquitous language.

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y-проверка (для UI-историй) — не применимо
- [ ] i18n: строки в обоих языках, хардкода нет (для UI-историй) — коды ошибок хранятся как ключи, тексты — в [EPIC-008](../../epic-008-i18n-en-ru/epic.md)

## Ссылки

- Документация: [`stack.md` → Раскладка монорепо](../../../docs/architecture/stack.md), [`stack.md` → Формат ошибок](../../../docs/architecture/stack.md), [`permission-model.md`](../../../docs/security/permission-model.md), [`glossary.md`](../../../docs/product/glossary.md)
- Правила: `rules/naming-and-structure.mdc`, `rules/api-contract.mdc`
