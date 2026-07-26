---
id: STORY-004-05
epic: EPIC-004
status: backlog
blocked: false
priority: must
estimate: M
---

# STORY-004-05 — TanStack Router: file-based маршруты, гарды, границы состояний

**Как** разработчик Bad CRM **я хочу** типобезопасную маршрутизацию с гардом на защищённую ветку и
явными состояниями загрузки и ошибки **чтобы** ссылка на несуществующий маршрут не компилировалась,
а пользователь никогда не видел белый экран.

## Acceptance (Given/When/Then)

- **Given** глобальная регистрация типов роутера (`declare module '@tanstack/react-router' { interface Register … }`) **When** пишу `<Link to="/dashbord">` **Then** это ошибка компиляции; автодополнение предлагает существующие пути и их параметры.
- **Given** pathless layout `_authenticated.tsx` с гардом **When** неаутентифицированный пользователь открывает `/dashboard` **Then** `beforeLoad` бросает `redirect({ to: '/login', search: { redirect: location.href } })` до загрузки данных и до рендера.
- **Given** аутентифицированный пользователь **When** он открывает `/login` **Then** гард `redirectIfAuthed` перенаправляет на `/dashboard`.
- **Given** маршрут со схемой search-параметров **When** в URL приходит `?page=abc&status=unknown` **Then** Zod приводит и валидирует: `page` отбрасывается/заменяется дефолтом, `status` вне whitelist отбрасывается, приложение не падает.
- **Given** маршрут с загрузкой данных **When** данные ещё не готовы дольше `defaultPendingMs` **Then** показывается `pendingComponent`, а не пустой экран; при ошибке загрузки — `errorComponent` с кнопкой повтора.
- **Given** несуществующий путь `/nope` **When** пользователь переходит по нему **Then** показывается `notFoundComponent` внутри оболочки приложения, навигация сохраняется.
- **Given** `defaultPreload: 'intent'` **When** пользователь наводит курсор на ссылку **Then** маршрут и его данные префетчатся; `defaultPreloadStaleTime: 0` — свежесть остаётся за TanStack Query.
- **Given** `context: { queryClient, auth }` **When** loader маршрута выполняет `queryClient.ensureQueryData(...)`, а компонент — `useSuspenseQuery` с тем же ключом **Then** второй сетевой запрос не выполняется.

## Задачи

- [ ] Написать тесты первыми: `app/routes/guards.test.tsx` (редирект без сессии, возврат по `search.redirect`, `redirectIfAuthed`), `app/routes/search-schema.test.ts` (валидация и приведение параметров, отбрасывание мусора), `app/routes/boundaries.test.tsx` (pending / error / notFound).
- [ ] Подключить плагин file-based маршрутов TanStack Router к Vite, настроить генерацию `routeTree.gen.ts` и исключить его из линта и покрытия.
- [ ] Реализовать `src/app/router.tsx`: `createRouter` с контекстом (`queryClient`, `auth`), `defaultPreload`, `defaultPendingMs`, глобальные `defaultPendingComponent`/`defaultErrorComponent`/`defaultNotFoundComponent`, блок `declare module`.
- [ ] Создать маршруты каркаса: `routes/__root.tsx`, `routes/_authenticated.tsx`, `routes/_authenticated/index.tsx` (redirect на `/dashboard`), `routes/_authenticated/dashboard.tsx` (заглушка), `routes/login.tsx` (заглушка для [EPIC-006](../../epic-006-auth-core/epic.md)).
- [ ] Реализовать `units/auth/lib/guards/` — `requireSession`, `redirectIfAuthed` (сигнатуры и контракт; наполнение логикой сессии — в [STORY-006-05](../../epic-006-auth-core/stories/story-006-05-client-session-bootstrap-and-guards.md)).
- [ ] Реализовать `shared/lib/validation/list-search.schema.ts` — общие поля списков (`page`, `perPage`, `cursor`, `q`, `sort`) для переиспользования всеми маршрутами.
- [ ] Настроить code-splitting по маршрутам (`.lazy.tsx`) и проверить бюджет начального чанка.
- [ ] Добавить тест соглашения: каждый маршрут с данными объявляет `pendingComponent` и `errorComponent`.

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y-проверка: при смене маршрута фокус переносится на заголовок страницы, изменение объявляется live-region
- [ ] i18n: строки в обоих языках, хардкода нет — тексты состояний загрузки/ошибки/404 берутся из `common.json`

## Ссылки

- Документация: [`ux-architecture.md` → Карта маршрутов, Гарды в `beforeLoad`](../../../docs/architecture/ux-architecture.md), [ADR-0007](../../../docs/architecture/adr/0007-tanstack-router-and-query.md)
- Правила: `rules/frontend-fsd.mdc`, `rules/a11y.mdc`
