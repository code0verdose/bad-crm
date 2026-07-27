---
id: STORY-003-05
epic: EPIC-003
status: backlog
blocked: false
priority: must
estimate: M
---

# STORY-003-05 — openapi.yaml как source of truth и генерация типов

**Как** разработчик Bad CRM **я хочу** чтобы контракт API был отдельным ревьюируемым файлом, из
которого генерируются типы клиента **чтобы** изменение API нельзя было внести незаметно, а
несуществующий путь или лишний параметр ловились компилятором, а не 400-й в проде.

## Acceptance (Given/When/Then)

- **Given** `docs/api/openapi.yaml` версии OpenAPI 3.1 **When** выполняю `pnpm api:lint` **Then** Spectral не находит ошибок; правила включают обязательные `operationId`, описания, ответы об ошибках и запрет `additionalProperties: true` на входных схемах.
- **Given** изменённая спецификация без перегенерации типов **When** CI выполняет `pnpm api:gen && git diff --exit-code` **Then** сборка падает с указанием, что нужно перегенерировать `api-schema.d.ts`.
- **Given** сгенерированный `packages/client/src/shared/api/schemas/api-schema.d.ts` **When** клиент вызывает несуществующий путь или передаёт лишний query-параметр **Then** это ошибка компиляции TypeScript.
- **Given** все продуктовые операции **When** смотрю их пути **Then** они находятся под префиксом `/api/v1`; служебные (`/health`, `/ready`, `/metrics`) в спецификацию не входят и перечислены в allow-list.
- **Given** ответ об ошибке в спецификации **When** смотрю схему **Then** используется общий компонент `Problem` с перечислением стабильных `code` как `enum`.
- **Given** попытка внести ломающее изменение в `v1` (удалить поле, сделать опциональное обязательным) **When** запускается diff-проверка спецификации против базовой ветки **Then** сборка падает с требованием завести `/api/v2` или сделать изменение совместимым.
- **Given** мутирующая операция **When** смотрю её описание **Then** объявлен заголовок `Idempotency-Key` и ответ 409 `idempotency_key_reuse`.

## Задачи

- [ ] Написать тесты первыми: `test/contract/openapi-lint.test.ts` (Spectral программно), `test/contract/codegen-freshness.test.ts` (сгенерированный файл совпадает с генерацией из текущей спеки), `test/contract/breaking-changes.test.ts` (сравнение с базовой ревизией спеки).
- [ ] Создать `docs/api/openapi.yaml`: `info`, `servers`, `security` (заготовка bearer), `components.schemas.Problem`, `components.parameters` (пагинация offset и cursor), `components.headers.IdempotencyKey`, первая операция — заглушка платформенного endpoint'а под `/api/v1`.
- [ ] Создать `.spectral.yaml` с набором правил проекта поверх `spectral:oas`.
- [ ] Добавить корневые скрипты `api:gen` (`openapi-typescript docs/api/openapi.yaml -o packages/client/src/shared/api/schemas/api-schema.d.ts`) и `api:lint`.
- [ ] Закоммитить сгенерированный `api-schema.d.ts` и исключить его из покрытия и из ESLint-форматирования.
- [ ] Добавить в CI шаги `api:lint`, `api:gen` + `git diff --exit-code`, проверку ломающих изменений.
- [ ] Описать в `docs/api/README.md` (или разделе `stack.md`) порядок изменения контракта: правка спеки → ревью → генерация → реализация → контрактный тест.
- [ ] **Зафиксировать в `docs/product/glossary.md` примитивы `packages/shared` и их форму на проводе.** Сегодня глоссарий описывает доменные сущности, но ни строкой не упоминает `Money`, `Email`, `Slug`, `Locale` и branded-идентификаторы — при том что ubiquitous language обязывает называть одно понятие одинаково в модели, в API и в коде. Без этой строки первая же реализация выберет представление сама: деньги уедут в ответ то числом, то строкой, id — то `uuid`, то `string`. **Сделано, когда:** в глоссарии появляется раздел про примитивы с RU/EN-названием, формой в JSON (`Money` — десятичная строка микроединиц + `currency`, id — UUID, email — нормализованный `trim`+`lowercase`) и ссылкой на файл схемы; те же формы описаны в `components.schemas` спеки. *(перенесено из [STORY-001-07](../../epic-001-monorepo-and-dev-env/stories/story-001-07-shared-package-foundation.md), 2026-07-27: раньше появления контракта эта строка была бы написана дважды)*

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y-проверка (для UI-историй) — не применимо
- [ ] i18n: строки в обоих языках, хардкода нет (для UI-историй) — не применимо

## Ссылки

- Документация: [`stack.md` → Контракт API, contract-first флоу](../../../docs/architecture/stack.md), [ADR-0003](../../../docs/architecture/adr/0003-openapi-as-source-of-truth.md)
- Правила: `rules/api-contract.mdc`
