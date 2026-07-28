---
id: STORY-004-06
epic: EPIC-004
status: review
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

- [x] Написать тесты первыми: `test/api/auth-middleware.test.ts` (добавление заголовка, дедуп refresh при N параллельных 401, единственный повтор, петля предотвращена), `test/api/problem.test.ts` (парсинг ошибки в типизированный объект), `test/api/idempotency.test.ts`. *Транспорт мокается через опцию `fetch` самого `openapi-fetch`, а не MSW — см. последний пункт.*
- [x] Реализовать `src/shared/api/http.client.ts`: `createClient<paths>({ baseUrl })` из `openapi-fetch` + `$api` через `openapi-react-query`.
- [x] Реализовать `src/shared/api/auth-middleware.util.ts`: подстановка токена, перехват 401, единый `refreshPromise` с дедупом, повтор исходного запроса, обработка провала.
- [x] Реализовать `src/units/auth/lib/auth-token-storage.util.ts` (только in-memory) и `auth-event-bus.util.ts` (события `logged-in`, `logged-out`, `refresh-failed`).
- [x] Реализовать `src/shared/api/problem.errors.ts` — разбор `application/problem+json` в `ApiError { code, status, issues, requestId }`.
- [x] Реализовать добавление `Idempotency-Key` для `POST`/`PUT`/`PATCH`/`DELETE` в middleware.
- [x] Добавить ESLint-правило: `fetch(`, `axios`, `XMLHttpRequest` запрещены вне `src/shared/api`; покрыть тестом. *Уже в `eslint.config.js` (`NO_FETCH_GLOBALS`, `AXIOS_OUTSIDE_SHARED_API`) с фикстурами в `test/lint/fixtures`; дополнительно `test/architecture/data-layer-conventions.test.ts` сканирует реальное дерево на Web Storage.*
- [ ] Настроить MSW для тестов и dev-моков, не подключая его в production-бандл. *Не понадобился: `openapi-fetch` принимает свой `fetch`, и подменять сетевой слой браузера ради этого — лишняя зависимость. MSW заводить под dev-моки/e2e, когда они появятся.*

## Definition of Done

- [x] Тесты написаны первыми (TDD), проходят, изменённый код покрыт — `packages/client` 100 % строк и ветвей
- [x] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [x] Документация обновлена (docs/ + запись в `docs/brain/`) — [`docs/brain/2026-07-28--client-data-layer.md`](../../../docs/brain/2026-07-28--client-data-layer.md) (STORY-004-04 и STORY-004-06); правок в `docs/` история не вносила — расхождений с `stack.md` по ходу не выявлено
- [x] a11y-проверка (для UI-историй) — не применимо
- [ ] i18n: строки в обоих языках, хардкода нет — сообщения ошибок выбираются по `code` из `errors.json`. *Клиент отдаёт только ключ `errors.<code>`; каталога ещё нет — EPIC-008.*

## Ссылки

- Документация: [`stack.md` → Правило клиента, Идемпотентность, Токены и сессии](../../../docs/architecture/stack.md), [`ux-architecture.md` → Права в интерфейсе](../../../docs/architecture/ux-architecture.md)
- Правила: `rules/api-contract.mdc`, `rules/security.mdc`
