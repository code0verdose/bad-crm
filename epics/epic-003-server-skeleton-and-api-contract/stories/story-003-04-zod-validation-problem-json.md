---
id: STORY-003-04
epic: EPIC-003
status: review
blocked: false
priority: must
estimate: S
---

# STORY-003-04 — Zod-валидация границ и формат problem+json

**Как** разработчик Bad CRM **я хочу** единый способ валидировать вход и единый формат ошибок
**чтобы** клиент обрабатывал ошибки одним кодом, а внутри границы данные были типобезопасны без
повторных проверок.

## Acceptance (Given/When/Then)

- **Given** endpoint с Zod-схемами `params`, `query`, `body` **When** приходит запрос с двумя невалидными полями **Then** ответ 422, `Content-Type: application/problem+json`, `code: "validation_failed"`, массив `errors[]` из двух записей с `path`, `code`, `message`.
- **Given** вложенное поле `amount.value` неверного типа **When** валидация падает **Then** `path` в ответе — `"amount.value"` (точечная нотация), а не индекс массива Zod-issue.
- **Given** query-параметр `page=abc` при схеме `z.coerce.number().int().positive()` **When** запрос обрабатывается **Then** 422 с `path: "page"`, а не 500 при попытке использовать `NaN`.
- **Given** валидный запрос **When** он проходит через middleware валидации **Then** в контроллер попадают уже приведённые значения (`page` — число, `enabled` — boolean), а повторной проверки в use-case нет.
- **Given** любая ошибка приложения **When** формируется ответ **Then** он содержит `type`, `title`, `status`, `code`, `requestId`; `detail` присутствует только для не-500 ошибок.
  > **Изменено 2026-07-27: поля `instance` в документе нет — намеренно.** Критерий требовал его при
  > написании истории. При реализации STORY-003-03 выяснилось, что единственное честное значение —
  > URL запроса, а его этот продукт печатать не может: есть маршруты, где сегмент пути *и есть*
  > credential (`/l/:token`), а problem-документ — ровно то, что пользователь вставляет в тикет.
  > Шаблон маршрута тоже отвергнут: утилита для него не принадлежит ни одному из слоёв, которым
  > пришлось бы её делить (это показал ESLint-запрет `presentation → infrastructure`). Идентичность
  > случая несёт `requestId`, который коррелирует со строкой лога, ничего не раскрывая. Решение
  > задокументировано в `packages/server/src/presentation/http/serializers/problem.serializer.ts`
  > и закреплено тестом на **отсутствие** поля.
- **Given** отсутствие доступа к сущности **чужой** организации **When** формируется ответ **Then** это 404 `<resource>_not_found`, а не 403 — API не является оракулом существования (проверяется тестом на выбранном примере).
- **Given** каталог кодов ошибок в `packages/shared` **When** запускается тест соответствия **Then** множество кодов совпадает с `enum` в `openapi.yaml`; расхождение валит сборку.
- **Given** превышение rate limit (заготовка) **When** возвращается 429 **Then** в ответе есть `Retry-After` и `code: "rate_limited"`.

## Задачи

- [x] Написать тесты первыми: `test/integration/http/validation.test.ts` (все сценарии выше), `test/unit/http/problem-json.test.ts` (форма ответа), `test/contract/error-codes.test.ts` (каталог ↔ спецификация).
- [x] Реализовать `presentation/http/middleware/validate.ts`: `validate({ params?, query?, body? })`, который парсит через `safeParse`, при ошибке бросает `ValidationError`, при успехе кладёт типизированные значения в `res.locals.validated`.
- [x] Реализовать преобразователь `ZodError → errors[]` с точечными путями и стабильными `code` из Zod-issue.
- [x] Реализовать `presentation/http/problem.ts` — сборка тела `application/problem+json` (RFC 9457) и установка корректного `Content-Type`.
- [x] Разместить схемы запросов в `presentation/http/validators/*.validator.ts`, общие примитивы переиспользовать из `packages/shared/validation`.
- [ ] Дополнить `packages/shared/errors/codes.ts` таблицей соответствия «ситуация → HTTP → code» из [`stack.md`](../../../docs/architecture/stack.md).
- [x] Описать формат ошибок в `docs/api/` (раздел или `components.schemas.Problem` в `openapi.yaml`).

## Definition of Done

- [x] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y-проверка (для UI-историй) — не применимо
- [ ] i18n: строки в обоих языках, хардкода нет (для UI-историй) — `code` переводится клиентом, см. [STORY-008-03](../../epic-008-i18n-en-ru/stories/story-008-03-server-error-codes-to-messages.md)

## Ссылки

- Документация: [`stack.md` → Формат ошибок `application/problem+json`](../../../docs/architecture/stack.md), [`stack.md` → Валидация входа](../../../docs/architecture/stack.md)
- Правила: `rules/api-contract.mdc`, `rules/security.mdc`
