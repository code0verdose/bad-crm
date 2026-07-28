---
id: STORY-004-05
epic: EPIC-004
status: review
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

- [x] Написать тесты первыми: `app/routes/guards.test.tsx` (редирект без сессии, возврат по `search.redirect`, `redirectIfAuthed`), `app/routes/search-schema.test.ts` (валидация и приведение параметров, отбрасывание мусора), `app/routes/boundaries.test.tsx` (pending / error / notFound).
- [x] Подключить плагин file-based маршрутов TanStack Router к Vite, настроить генерацию `routeTree.gen.ts` и исключить его из линта и покрытия.
- [x] Реализовать `src/app/router.tsx`: `createRouter` с контекстом (`queryClient`, `auth`), `defaultPreload`, `defaultPendingMs`, глобальные `defaultPendingComponent`/`defaultErrorComponent`/`defaultNotFoundComponent`, блок `declare module`.
- [x] Создать маршруты каркаса: `routes/__root.tsx`, `routes/_authenticated.tsx`, `routes/_authenticated/index.tsx` (redirect на `/dashboard`), `routes/_authenticated/dashboard.tsx` (заглушка), `routes/login.tsx` (заглушка для [EPIC-006](../../epic-006-auth-core/epic.md)).
- [x] Реализовать `units/auth/lib/guards/` — `requireSession`, `redirectIfAuthed` (сигнатуры и контракт; наполнение логикой сессии — в [STORY-006-05](../../epic-006-auth-core/stories/story-006-05-client-session-bootstrap-and-guards.md)).
      Лежат в каноническом месте: `src/units/auth/lib/guards/` (`require-session.guard.ts`,
      `redirect-if-authed.guard.ts`, `guard-args.types.ts`, barrel). Гарды — чистые функции над
      двумя полями `beforeLoad`, поэтому тестируются без поднятия роутера
      (`packages/client/test/routes/guards.test.ts`).
- [x] Реализовать `shared/lib/validation/list-search.schema.ts` — общие поля списков (`page`, `perPage`, `cursor`, `q`, `sort`) для переиспользования всеми маршрутами.
      `src/shared/lib/validation/list-search.schema.ts`: `z.coerce` на всех полях (URL отдаёт только
      строки), `.catch()` на дефолт вместо падения на `?page=abc`, `perPage` ограничен серверным
      потолком, пустые `q`/`cursor` отбрасываются.
- [x] Настроить code-splitting по маршрутам (`.lazy.tsx`) и проверить бюджет начального чанка.
- [x] Добавить тест соглашения: каждый маршрут с данными объявляет `pendingComponent` и `errorComponent`.
      `packages/client/test/architecture/route-state-conventions.test.ts` — читает `src/app/routes/**`
      как данные. Сегодня «голый экран» невозможен и без него (`router.tsx` задаёт
      `defaultPendingComponent`/`defaultErrorComponent`, их наследует каждый маршрут); тест страхует
      день, когда маршрут заведёт собственный `pendingComponent` и забудет парный `errorComponent`.

## Definition of Done

- [x] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [x] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [x] Документация обновлена (docs/ + запись в `docs/brain/`)
- [x] a11y-проверка: при смене маршрута фокус переносится на заголовок страницы, изменение объявляется live-region
- [ ] i18n: строки в обоих языках, хардкода нет — тексты состояний загрузки/ошибки/404 берутся из `common.json` — **частично:** ключи проставлены (`errors.not_found.{title,description,action}` в `app/ui/route-not-found.component.tsx`, `errors.route.failed` в `app/ui/route-error.component.tsx`;
  `RoutePending` рендерит скелетон и текста не содержит), хардкод-строк нет; каталогов EN/RU нет — [STORY-008-01](../../epic-008-i18n-en-ru/stories/story-008-01-i18next-setup-and-namespaces.md). **Подтверждено открытым (2026-07-28):** каталогов нет — `packages/client/src/shared/i18n` не существует

## Ссылки

- Документация: [`ux-architecture.md` → Карта маршрутов, Гарды в `beforeLoad`](../../../docs/architecture/ux-architecture.md), [ADR-0007](../../../docs/architecture/adr/0007-tanstack-router-and-query.md)
- Правила: `rules/frontend-fsd.mdc`, `rules/a11y.mdc`
