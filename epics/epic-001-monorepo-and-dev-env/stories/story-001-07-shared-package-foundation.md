---
id: STORY-001-07
epic: EPIC-001
status: done
blocked: false
priority: must
estimate: S
---

# STORY-001-07 — packages/shared: типы, Zod-примитивы, каталог permissions

**Как** разработчик Bad CRM **я хочу** изоморфный пакет с общими типами, Zod-примитивами и кодами
ошибок **чтобы** клиент и сервер описывали одни и те же понятия одним кодом, а не двумя
расходящимися копиями.

## Acceptance (Given/When/Then)

- [x] **Given** `packages/shared` **When** импортирую его из `server` и из `client` **Then** сборка обоих проходит: пакет собран в ESM + `.d.ts`, экспорты объявлены через `exports` в `package.json`.
- [x] **Given** branded-тип `OrganizationId` **When** передаю в функцию, ожидающую `UserId`, обычную строку или `OrganizationId` **Then** первые два случая — ошибка компиляции, третий — успех. *Проверяется `@ts-expect-error` в `packages/shared/test/validation/entity-id.test.ts`; чтобы эти утверждения не были пустыми, тесты пакета компилируются отдельным проектом `tsconfig.test.json` (`test/repo/tsconfig-contract.test.ts`).*
- [x] **Given** Zod-примитив `emailSchema` **When** валидирую `"  User@Example.COM "` **Then** `safeParse` успешен и возвращает нормализованное `user@example.com` (`trim` + `toLowerCase` через `.transform`).
- [x] **Given** каталог кодов ошибок `errors/codes.ts` **When** обращаюсь к неизвестному коду **Then** это ошибка компиляции: коды объявлены как union, а не как произвольные строки. *Файл называется `errors/error-code.enums.ts` — role-suffix по `rules/naming-and-structure.mdc`.*
- [x] **Given** заготовка каталога permissions **When** объявляю ключ в формате, отличном от `<resource>:<action>` **Then** тест формата падает: все ключи обязаны соответствовать регулярному выражению и быть уникальными.
- [x] **Given** `packages/shared` **When** прогоняю тест изоморфности **Then** ни одного импорта `node:*` и ни одного обращения к `window`/`document` — пакет работает в обоих рантаймах.
- [x] **Given** денежный примитив **When** создаю сумму из дробного числа **Then** конструктор отвергает значение: деньги хранятся целым числом минорных единиц вместе с кодом валюты. *Реализовано строже плана: `bigint` микроединиц, а не `number` минорных, — тип, который дробь не может хранить в принципе.*

## Задачи

- [x] Написать тесты первыми: `src/ids/ids.test.ts` (branded-типы, генерация и парсинг), `src/validation/primitives.test.ts` (email, slug, пагинация, деньги, ISO-даты), `src/errors/codes.test.ts` (уникальность и формат), `src/permissions/catalog.test.ts` (формат `<resource>:<action>`, уникальность ключей, непустое описание). *Тесты лежат в `packages/shared/test/**`, а не рядом с исходниками: `include: ["src/**"]` собирается в `dist`, и тесты попали бы в опубликованный пакет.*
- [x] Реализовать `packages/shared/src/ids/` — branded-типы `OrganizationId`, `UserId`, `ProjectId`, `TaskId` + фабрики `asOrganizationId` с рантайм-проверкой UUID. *Отклонение: без отдельного сегмента `ids/` — всё в `validation/entity-id.schema.ts`. Branded-тип здесь **выводится** из Zod-схемы (`.brand<'UserId'>()`), то есть является той же валидацией; отдельный каталог означал бы два определения `UserId` в двух местах. Набор шире плана (`TeamId`, `RoleId`, `BoardId`, `SprintId` и др.), фабрики `asOrganizationId`/`asUserId`/`asProjectId`/`asTaskId` на месте.*
- [x] Реализовать `packages/shared/src/validation/` — `email.schema.ts`, `slug.schema.ts`, `money.schema.ts`, `pagination.schema.ts` (offset и cursor варианты), `iso-date.schema.ts`; экспорт через barrel. *`iso-date.schema.ts` называется `date.schema.ts`; добавлены `password.schema.ts`, `locale.schema.ts`, `timezone.schema.ts`, `sorting.schema.ts`, `money.util.ts`.*
- [x] Реализовать `packages/shared/src/errors/codes.ts` — каталог стабильных машинных кодов (`validation_failed`, `unauthenticated`, `rate_limited`, `stale_version`, `internal_error`, `feature_disabled`, шаблоны `<resource>_not_found` / `<resource>_forbidden`) как union + карта HTTP-статусов. *Файл — `errors/error-code.enums.ts`.*
- [x] Реализовать `packages/shared/src/permissions/catalog.ts` — заготовка каталога permissions (структура записи: `key`, `resource`, `action`, `category`, `isDangerous`, `descriptionKey`), пока с минимальным набором ключей `organization:read`, `organization:update`. Полное наполнение — [EPIC-011](../../epic-011-rbac-permissions/epic.md). *Файл — `permissions/permissions.catalog.ts`; рядом `access-level.enums.ts` и `can.util.ts` с порогом 100 % покрытия.*
- [x] Реализовать `packages/shared/src/result/` — `Result<T, E>` и хелперы, используемые доменом сервера.
- [x] Настроить сборку пакета (`tsc` → `dist`), поле `exports` с подпутями (`./validation`, `./errors`, `./permissions`, `./ids`), `sideEffects: false`. *Подпуть `./ids` отсутствует — сегмента `ids/` нет (см. выше); вместо него объявлены `./validation`, `./errors`, `./permissions`, `./result`, `./types`. Набор подпутей закреплён `packages/shared/test/config/public-api.test.ts`.*
- [ ] Зафиксировать в `docs/product/glossary.md` соответствие имён примитивов ubiquitous language. — **не выполнено:** в глоссарии есть доменные термины, но нет ни строки про `Money`, `Email`, `Slug`, branded-идентификаторы и их представление. **Перенесено в [STORY-003-05](../../epic-003-server-skeleton-and-api-contract/stories/story-003-05-openapi-contract-and-codegen.md)**: именно там формы этих примитивов на проводе (`Money` как десятичная строка, id как UUID, нормализованный email) становятся частью контракта API и обязаны быть названы один раз — в глоссарии, спеке и коде одинаково.

## Definition of Done

- [x] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [x] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [x] Документация обновлена (docs/ + запись в `docs/brain/`)
- [x] a11y-проверка (для UI-историй) — не применимо
- [x] i18n: строки в обоих языках, хардкода нет (для UI-историй) — коды ошибок хранятся как ключи, тексты — в [EPIC-008](../../epic-008-i18n-en-ru/epic.md)

> **Статус `done` при одной незакрытой задаче.** Все семь acceptance-критериев выполнены и покрыты
> тестами. Открытым остался только пункт про глоссарий, и он перенесён осознанно: описывать
> «соответствие имён примитивов ubiquitous language» до того, как у этих примитивов появилась форма
> на проводе, значит писать строку, которую придётся переписать в
> [STORY-003-05](../../epic-003-server-skeleton-and-api-contract/stories/story-003-05-openapi-contract-and-codegen.md)
> вместе со спекой. Пункт заведён там же.

## Ссылки

- Документация: [`stack.md` → Раскладка монорепо](../../../docs/architecture/stack.md), [`stack.md` → Формат ошибок](../../../docs/architecture/stack.md), [`permission-model.md`](../../../docs/security/permission-model.md), [`glossary.md`](../../../docs/product/glossary.md)
- Правила: `rules/naming-and-structure.mdc`, `rules/api-contract.mdc`
