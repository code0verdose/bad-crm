---
id: STORY-004-06
epic: EPIC-004
status: backlog
blocked: false
priority: must
estimate: M
---

# STORY-004-06 — Типизированный API-клиент, auth-middleware, 401 → refresh с дедупом

**Как** разработчик Bad CRM **я хочу** единственный типизированный способ ходить в API с
автоматическим обновлением токена **чтобы** ошибки контракта ловились компилятором, а истёкший
access-токен не приводил к каскаду параллельных refresh-запросов и вылету пользователя.

## Acceptance (Given/When/Then)

- **Given** клиент `openapi-fetch`, типизированный сгенерированной схемой **When** вызываю несуществующий путь или передаю лишний параметр **Then** это ошибка компиляции, а не 400 в рантайме.
- **Given** запрос к защищённому endpoint'у **When** в памяти есть access-токен **Then** middleware добавляет заголовок `Authorization: Bearer …`; токен нигде не сохраняется в `localStorage`.
- **Given** три параллельных запроса и истёкший access-токен **When** все три получают 401 **Then** выполняется ровно один `POST /api/v1/auth/refresh` (дедуп через общий promise), после успеха все три запроса повторяются один раз и завершаются успешно.
- **Given** неуспешный refresh (401/403) **When** он возвращает ошибку **Then** сессия очищается, публикуется событие logout, пользователь редиректится на `/login?redirect=…`, повторных попыток refresh нет.
- **Given** запрос, уже повторённый после refresh **When** он снова получает 401 **Then** второй цикл refresh не запускается (защита от бесконечной петли).
- **Given** мутация **When** она отправляется **Then** обёртка автоматически добавляет заголовок `Idempotency-Key` (UUIDv4), одинаковый при ретраях одного логического действия.
- **Given** ответ `application/problem+json` **When** клиент его получает **Then** он преобразуется в типизированную ошибку с полем `code`, по которому выбирается сообщение; сырой `detail` пользователю не показывается.
- **Given** отменённый запрос (смена фильтра, размонтирование) **When** срабатывает `AbortController` **Then** ошибка распознаётся как `AbortError` и не показывается пользователю.

## Задачи

- [ ] Написать тесты первыми (MSW + fake timers): `shared/api/auth-middleware.test.ts` (добавление заголовка, дедуп refresh при N параллельных 401, единственный повтор, петля предотвращена), `shared/api/problem.test.ts` (парсинг ошибки в типизированный объект), `shared/api/idempotency.test.ts`.
- [ ] Реализовать `src/shared/api/client.ts`: `createClient<paths>({ baseUrl })` из `openapi-fetch` + `$api` через `openapi-react-query`.
- [ ] Реализовать `src/shared/api/auth-middleware.ts`: подстановка токена, перехват 401, единый `refreshPromise` с дедупом, повтор исходного запроса, обработка провала.
- [ ] Реализовать `src/units/auth/lib/auth-token-storage.ts` (только in-memory) и `auth-event-bus.ts` (события `logged-in`, `logged-out`, `refresh-failed`).
- [ ] Реализовать `src/shared/api/problem.ts` — разбор `application/problem+json` в `ApiError { code, status, errors?, requestId }`.
- [ ] Реализовать добавление `Idempotency-Key` для `POST`/`PATCH`/`DELETE` в middleware.
- [ ] Добавить ESLint-правило: `fetch(`, `axios`, `XMLHttpRequest` запрещены вне `src/shared/api`; покрыть тестом.
- [ ] Настроить MSW для тестов и dev-моков, не подключая его в production-бандл.

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y-проверка (для UI-историй) — не применимо
- [ ] i18n: строки в обоих языках, хардкода нет — сообщения ошибок выбираются по `code` из `errors.json`

## Ссылки

- Документация: [`stack.md` → Правило клиента, Идемпотентность, Токены и сессии](../../../docs/architecture/stack.md), [`ux-architecture.md` → Права в интерфейсе](../../../docs/architecture/ux-architecture.md)
- Правила: `rules/api-contract.mdc`, `rules/security.mdc`
