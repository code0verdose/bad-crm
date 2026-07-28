---
id: STORY-006-05
epic: EPIC-006
status: backlog
blocked: false
priority: must
estimate: M
---

# STORY-006-05 — Клиент: bootstrap сессии, гард, redirect

**Как** разработчик (пользователь продукта) **я хочу** чтобы после перезагрузки страницы я
оставался в системе и попадал именно туда, куда шёл **чтобы** не терять контекст при каждом
обновлении вкладки и при переходе по ссылке из письма.

## Acceptance (Given/When/Then)

- **Given** действующая refresh-cookie и пустая память вкладки **When** приложение загружается **Then** выполняется bootstrap сессии (один `POST /auth/refresh`), после чего пользователь остаётся аутентифицированным без экрана логина.
- **Given** выполняющийся bootstrap **When** приложение ещё не знает, авторизован ли пользователь **Then** показывается нейтральный экран загрузки, а не мигание формы логина (проверяется тестом: `/login` не рендерится ни на один кадр).
- **Given** отсутствие или недействительность refresh-cookie **When** bootstrap завершается неуспехом **Then** пользователь оказывается на `/login`, ошибки в тост не выводятся (это штатный сценарий, а не сбой).
- **Given** неаутентифицированный пользователь **When** он открывает `/settings/security` **Then** гард `requireSession` в `beforeLoad` бросает `redirect({ to: '/login', search: { redirect: '/settings/security' } })`; после входа он попадает именно на `/settings/security`.
- **Given** значение `redirect` в search-параметрах **When** оно указывает на внешний домен (`https://evil.example`) **Then** оно отбрасывается схемой валидации, и пользователь попадает на `/dashboard` — open redirect невозможен.
- **Given** аутентифицированный пользователь **When** он открывает `/login` **Then** `redirectIfAuthed` уводит его на `/dashboard`.
- **Given** событие `refresh-failed` из auth-middleware **When** оно происходит в фоне **Then** состояние сессии сбрасывается, роутер инвалидируется (`router.invalidate()`), гарды перепроверяются, и пользователь оказывается на `/login`.
- **Given** успешный вход **When** сессия установлена **Then** `router.invalidate()` перепроверяет гарды, и защищённые маршруты становятся доступны без перезагрузки страницы.

## Задачи

- [ ] Написать тесты первыми: `units/auth/service/hooks/use-bootstrap-session.hook.test.tsx` (успешный и неуспешный bootstrap, отсутствие мигания логина), `units/auth/lib/guards/guards.test.ts` (редирект и возврат, отбрасывание внешнего redirect), `app/router-invalidate.test.tsx` (перепроверка гардов после логина и logout).
- [ ] Реализовать `units/auth/service/stores/auth.store.ts` (или контекст) с состоянием `unknown | authenticated | anonymous` и данными пользователя.
- [ ] Реализовать `units/auth/service/hooks/use-bootstrap-session.hook.ts` — единственный вызов refresh при старте приложения, дедуп с auth-middleware.
- [x] Реализовать `units/auth/lib/guards/require-session.ts` и `redirect-if-authed.ts`, подключить к `_authenticated.tsx` и `login.tsx`.
      *Закрыто ревизией 2026-07-28:* сделано в EPIC-004 —
      `packages/client/src/units/auth/lib/guards/require-session.guard.ts` и
      `.../redirect-if-authed.guard.ts` (имена с role-суффиксом по `rules/naming-and-structure.mdc`),
      подключены как `beforeLoad` в `packages/client/src/app/routes/_authenticated.tsx:16` и
      `packages/client/src/app/routes/login.tsx:17`, покрыты `packages/client/test/routes/guards.test.ts`.
      Пометка стояла невыполненной при уже существующей реализации. **Остаётся:** гарды сейчас
      читают `auth.status` из контекста роутера, которым никто не управляет — реальным источником он
      станет вместе со стором и bootstrap'ом из двух пунктов выше.
- [x] Реализовать Zod-схему `loginSearchSchema` с валидацией `redirect`: только относительные пути внутри приложения.
      *Закрыто ревизией 2026-07-28:* `packages/client/src/units/auth/model/validation/login-search.schema.ts:23`,
      используется как `validateSearch` в `packages/client/src/app/routes/login.tsx:16`; отбрасывание
      внешнего `redirect` проверяется в `packages/client/test/routes/guards.test.ts`.
- [ ] Прокинуть `auth` в контекст роутера (`createRouter({ context: { queryClient, auth } })`) и обеспечить `router.invalidate()` на события шины аутентификации.
- [ ] Реализовать полную очистку `queryClient` при logout и при смене пользователя.
- [ ] Добавить экран загрузки приложения (использует скелетоны из [EPIC-007](../../epic-007-design-system/epic.md)).

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y-проверка: экран загрузки объявлен как `aria-busy`/live-region, фокус после редиректа переносится на заголовок целевой страницы
- [ ] i18n: строки в обоих языках, хардкода нет

## Ссылки

- Документация: [`ux-architecture.md` → Гарды в `beforeLoad`, Клиентская проверка — только подсказка](../../../docs/architecture/ux-architecture.md), [ADR-0007](../../../docs/architecture/adr/0007-tanstack-router-and-query.md)
- Правила: `rules/frontend-fsd.mdc`, `rules/security.mdc`
