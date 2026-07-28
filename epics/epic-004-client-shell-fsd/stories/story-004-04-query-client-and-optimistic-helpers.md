---
id: STORY-004-04
epic: EPIC-004
status: in-progress
blocked: false
priority: must
estimate: M
---

# STORY-004-04 — QueryClient, глобальные ошибки мутаций, optimistic-хелперы, фабрика ключей

**Как** разработчик Bad CRM **я хочу** единую политику кеширования, один источник ошибок мутаций и
готовые оптимистичные хелперы **чтобы** каждый домен не изобретал свои дефолты, а пользователь не
получал два тоста на один сбой.

## Acceptance (Given/When/Then)

- **Given** `QueryClient` с `{ queries: { retry: 1, staleTime: 30_000 } }` **When** запрос падает с 500 **Then** выполняется ровно один повтор; при 401 повтор не выполняется (обработка — в auth-middleware).
- **Given** глобальный `MutationCache.onError` **When** мутация падает с серверной ошибкой **Then** показывается ровно один красный тост; `AbortError` пропускается и тоста не вызывает.
- **Given** мутация со своим `onError` **When** она падает **Then** локальный обработчик **переопределяет** глобальный, а не добавляет второй тост (проверяется тестом: за одну ошибку ровно один вызов `notify.error`).
- **Given** оптимистичное переключение флага **When** запрос падает **Then** `runOptimisticPatch` откатывает состояние из снапшота, а `onSettled` инвалидирует ключи; итоговое состояние совпадает с серверным.
- **Given** оптимистичное удаление элемента списка **When** сервер отвечает ошибкой **Then** элемент возвращается на прежнюю позицию, а не в конец списка.
- **Given** запрос списка **When** он выполняется **Then** `signal` из TanStack Query прокинут в `fetch`; при смене фильтра предыдущий запрос отменяется (в тесте — счётчик `abort`).
- **Given** ad-hoc массив в качестве query-ключа (`useQuery({ queryKey: ['tasks', id] })`) **When** запускается линт/тест **Then** он падает: ключи создаются только фабрикой `QueryKeys.*`.
- **Given** фабрика ключей **When** вызываю `QueryKeys.Sessions.list({ page: 2 })` **Then** тип параметров проверяется компилятором, а инвалидация по `QueryKeys.Sessions.all` затрагивает все производные ключи.

## Задачи

- [x] Написать тесты первыми: `test/api/optimistic.test.ts` (patch/remove/rollback, порядок snapshot → mutate → error → rollback), `test/api/query-client.test.ts` (дефолты, единственный тост, пропуск `AbortError`), `test/api/query-keys.test.ts` (типобезопасность и иерархия ключей). *Тесты живут в `packages/client/test/api/`, а не рядом с исходником: так же, как уже написанный `test/api/api-schema.test.ts`.*
- [x] Реализовать `src/shared/api/query-client.config.ts`: дефолты запросов, `MutationCache` с `onError`, `QueryCache` с логированием ошибок через инжектируемый порт (`logError`). *Не `app/`: фабрике нужны тостер и лог-сток из слоёв выше, поэтому она принимает их аргументами, а `app/providers.tsx` вызывает `createAppQueryClient`.*
- [x] Реализовать `src/shared/lib/enums/query-keys.constant.ts` — типизированная фабрика с иерархией `all` → `list(params)` → `detail(id)`.
- [x] Реализовать `src/shared/api/optimistic.util.ts`: `runOptimisticPatch`, `runOptimisticRemove`, `rollbackOptimistic` (синхронный `setQueriesData` + snapshot, `cancelQueries` fire-and-forget).
- [x] Зафиксировать правило выбора стратегии: optimistic — для toggle/inline-edit/delete/dnd; pessimistic (`onSuccess` → `invalidateQueries`) — для create и тяжёлых записей. *Записано в заголовке `optimistic.util.ts`.*
- [ ] Подключить `@tanstack/react-query-devtools` только в dev-сборке. *Монтирование — в `app/providers.tsx`, вне этой поставки.*
- [x] Добавить ESLint-правило/тест против ad-hoc query-ключей и против `useQuery` вне `units/*/service`. *Ключи — `test/architecture/data-layer-conventions.test.ts`; `useQuery` вне юнитов уже запрещён `QUERY_HOOK_CALLS` в `eslint.config.js`.*
- [ ] Задокументировать паттерн в `docs/architecture/ux-architecture.md` и `rules/frontend-fsd.mdc`.

## Definition of Done

- [x] Тесты написаны первыми (TDD), проходят, изменённый код покрыт — `packages/client` 100 % строк и ветвей
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [x] a11y-проверка (для UI-историй) — не применимо
- [ ] i18n: строки в обоих языках, хардкода нет — тексты ошибок берутся из `errors.json` по коду. *Клиент отдаёт только ключ `errors.<code>` (`errorMessageKey`); самого каталога `errors.json` ещё нет — EPIC-008.*

## Ссылки

- Документация: [`ux-architecture.md` → Паттерны взаимодействия](../../../docs/architecture/ux-architecture.md), [ADR-0007](../../../docs/architecture/adr/0007-tanstack-router-and-query.md)
- Правила: `rules/frontend-fsd.mdc`, `rules/design-system.mdc`
