---
id: EPIC-004
title: Каркас клиента на FSD
status: backlog
blocked: false
milestone: M1
owner: unassigned
created: 2026-07-26
---

# EPIC-004 — Каркас клиента на FSD

## Зачем (ценность)

Клиент Bad CRM будет содержать десятки доменов — задачи, документы, чат, vault, дашборды. Без
заранее заданной структуры слоёв, типизированного клиента API, единой политики кеширования и
маршрутизации с гардами каждый домен изобретёт свой способ ходить в сеть и хранить состояние.
Эпик даёт каркас: FSD «units» с проверяемым линтером направлением зависимостей, TanStack Router с
типизированными search-параметрами, TanStack Query с едиными дефолтами и оптимистичными
хелперами, `openapi-fetch` вместо raw `fetch` — и оболочку приложения, в которую дальше вставляются
экраны.

## Scope

### В скоупе

- Vite + React 19 + TypeScript strict, алиасы `@app`, `@pages`, `@widgets`, `@units`, `@shared` в tsconfig и vite.
- Скелет слоёв FSD, namespace-барели, ESLint-правило направления зависимостей.
- `MantineProvider`, тема, CSS Modules, `postcss-preset-mantine`, светлая и тёмная темы.
- `QueryClient` с дефолтами (`retry: 1`, `staleTime: 30s`), глобальный `MutationCache.onError`, `shared/api/optimistic.ts`, типизированная фабрика query-ключей.
- TanStack Router file-based, глобальная регистрация типов, `_authenticated.tsx`, `pendingComponent` / `errorComponent` / `notFoundComponent`.
- `openapi-fetch` + `openapi-react-query`, auth-middleware, обработка 401 → refresh с дедупликацией.
- Оболочка: сайдбар, шапка, переключатель организации, хлебные крошки.

### Вне скоупа

- Содержательные компоненты дизайн-системы (`DataState`, скелетоны, тостер) — [EPIC-007](../epic-007-design-system/epic.md).
- Локализация интерфейса — [EPIC-008](../epic-008-i18n-en-ru/epic.md).
- Реальные экраны логина и сессии — [EPIC-006](../epic-006-auth-core/epic.md) (здесь только гарды и точки подключения).
- Realtime-подписки — [EPIC-025](../epic-025-realtime-infrastructure/epic.md).

## Acceptance (эпик выполнен, когда)

- [ ] `pnpm --filter @bad-crm/client dev` открывает приложение с оболочкой; сборка `vite build` проходит, начальный JS-бандл маршрута < 300 КБ gzip.
- [ ] Нарушение направления зависимостей FSD (`shared` → `units`, `units` → `widgets`, импорт внутрь юнита мимо barrel) падает на `pnpm lint`.
- [ ] Все сетевые вызовы идут через типизированный клиент; `fetch(`/`axios` вне `shared/api` запрещены линтером.
- [ ] Один истёкший access-токен при трёх параллельных запросах приводит ровно к одному вызову refresh; после успеха все три запроса повторяются и завершаются успешно.
- [ ] Переход на защищённый маршрут без сессии редиректит на `/login?redirect=…`; после входа пользователь возвращается на исходный URL.
- [ ] Каждый маршрут с данными имеет `pendingComponent` и `errorComponent`; несуществующий путь показывает `notFoundComponent`, а не белый экран.
- [ ] Тема переключается `system | light | dark`, значения берутся из токенов Mantine и `light-dark()`; литеральных цветов в CSS-модулях нет (проверяется линтером стилей).
- [ ] Query-ключи создаются только через типизированную фабрику; ad-hoc массивы в хуках запрещены и покрыты тестом.

## Зависимости / риски

- Зависит от: [EPIC-001](../epic-001-monorepo-and-dev-env/epic.md) (монорепо и алиасы), [EPIC-003](../epic-003-server-skeleton-and-api-contract/epic.md) (сгенерированные типы API).
- Блокирует: [EPIC-006](../epic-006-auth-core/epic.md) (клиентская часть auth), [EPIC-007](../epic-007-design-system/epic.md), [EPIC-008](../epic-008-i18n-en-ru/epic.md), все продуктовые эпики с UI.
- Риски: расползание бизнес-логики в компоненты — митигируется правилом «логика в хуках юнита» и линтером; дублирование состояния фильтров между URL и локальным стейтом — митигируется правилом «URL — единственный источник правды»; размер бандла — митигируется code-splitting по маршрутам и бюджетом в `size-limit`.

## Ссылки

- Документация: [`ux-architecture.md` → Карта маршрутов, Дизайн-система, Права в интерфейсе](../../docs/architecture/ux-architecture.md), [`stack.md` → Правило клиента](../../docs/architecture/stack.md), [ADR-0005](../../docs/architecture/adr/0005-fsd-units-frontend-architecture.md), [ADR-0006](../../docs/architecture/adr/0006-mantine-css-modules-no-tailwind.md), [ADR-0007](../../docs/architecture/adr/0007-tanstack-router-and-query.md)
- Правила: `rules/frontend-fsd.mdc`, `rules/design-system.mdc`, `rules/api-contract.mdc`

## Истории

- [ ] [STORY-004-01 — Vite, React 19, strict TS и алиасы слоёв](stories/story-004-01-vite-react-strict-aliases.md)
- [ ] [STORY-004-02 — Скелет слоёв FSD, namespace-барели, линт зависимостей](stories/story-004-02-fsd-layers-and-dependency-lint.md)
- [ ] [STORY-004-03 — MantineProvider, тема, CSS Modules, светлая и тёмная темы](stories/story-004-03-mantine-provider-theme-css-modules.md)
- [ ] [STORY-004-04 — QueryClient, глобальные ошибки мутаций, optimistic-хелперы, фабрика ключей](stories/story-004-04-query-client-and-optimistic-helpers.md)
- [ ] [STORY-004-05 — TanStack Router: file-based маршруты, гарды, границы состояний](stories/story-004-05-tanstack-router-file-based-guards.md)
- [ ] [STORY-004-06 — Типизированный API-клиент, auth-middleware, 401 → refresh с дедупом](stories/story-004-06-typed-api-client-auth-middleware.md)
- [ ] [STORY-004-07 — Оболочка: сайдбар, шапка, переключатель организации, хлебные крошки](stories/story-004-07-app-shell-sidebar-topbar-breadcrumbs.md)
