---
id: STORY-004-04
epic: EPIC-004
status: backlog
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

- [ ] Написать тесты первыми: `shared/api/optimistic.test.ts` (patch/remove/rollback, порядок snapshot → mutate → error → rollback), `app/query-client.test.ts` (дефолты, единственный тост, пропуск `AbortError`), `shared/lib/enums/query-keys.test.ts` (типобезопасность и иерархия ключей).
- [ ] Реализовать `src/app/query-client.config.ts`: дефолты запросов, `MutationCache` с `onError`, `QueryCache` с логированием ошибок через порт логирования клиента.
- [ ] Реализовать `src/shared/lib/enums/query-keys.ts` — типизированная фабрика с иерархией `all` → `list(params)` → `detail(id)`.
- [ ] Реализовать `src/shared/api/optimistic.ts`: `runOptimisticPatch`, `runOptimisticRemove`, `rollbackOptimistic` (синхронный `setQueriesData` + snapshot, `cancelQueries` fire-and-forget).
- [ ] Зафиксировать правило выбора стратегии: optimistic — для toggle/inline-edit/delete/dnd; pessimistic (`onSuccess` → `invalidateQueries`) — для create и тяжёлых записей.
- [ ] Подключить `@tanstack/react-query-devtools` только в dev-сборке.
- [ ] Добавить ESLint-правило/тест против ad-hoc query-ключей и против `useQuery` вне `units/*/service`.
- [ ] Задокументировать паттерн в `docs/architecture/ux-architecture.md` и `rules/frontend-fsd.mdc`.

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y-проверка (для UI-историй) — не применимо
- [ ] i18n: строки в обоих языках, хардкода нет — тексты ошибок берутся из `errors.json` по коду

## Ссылки

- Документация: [`ux-architecture.md` → Паттерны взаимодействия](../../../docs/architecture/ux-architecture.md), [ADR-0007](../../../docs/architecture/adr/0007-tanstack-router-and-query.md)
- Правила: `rules/frontend-fsd.mdc`, `rules/design-system.mdc`
