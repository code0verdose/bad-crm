---
id: STORY-006-05
epic: EPIC-006
status: review
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

- [x] Написать тесты первыми: `units/auth/service/hooks/use-bootstrap-session.hook.test.tsx` (успешный и неуспешный bootstrap, отсутствие мигания логина), `units/auth/lib/guards/guards.test.ts` (редирект и возврат, отбрасывание внешнего redirect), `app/router-invalidate.test.tsx` (перепроверка гардов после логина и logout).
      *Закрыто 2026-07-29.* Имена файлов отличаются от плана — сами проверки на месте:
      `packages/client/src/units/auth/service/hooks/use-bootstrap-session.hook.test.tsx`,
      `packages/client/test/routes/guards.test.ts` (редирект, возврат, пять форм небезопасного
      `redirect`), `packages/client/test/app/session-bootstrap.test.tsx` («`/login` не рендерится ни
      на один кадр»), `packages/client/test/app/composition.test.ts` (`logged-in` →
      `router.invalidate()`, `logged-out` → навигация и очистка кеша) и
      `packages/client/test/routes/sign-in-flow.test.tsx` (сквозной путь). Отдельного
      `app/router-invalidate.test.tsx` нет: перепроверка гардов — это подписка на шину, и её место
      рядом с остальной проводкой композиционного корня.
- [x] Реализовать `units/auth/service/stores/auth.store.ts` (или контекст) с состоянием `unknown | authenticated | anonymous` и данными пользователя.
      *Закрыто 2026-07-29:* `packages/client/src/units/auth/service/stores/auth-session.store.ts`
      (`createAuthSessionStore` + единственный экземпляр `authSession`). Вне React и вне кеша
      TanStack Query: гард читает состояние из `beforeLoad`, до всякого рендера, а
      `queryClient.clear()` на выходе иначе стёр бы саму сессию.
- [x] Реализовать `units/auth/service/hooks/use-bootstrap-session.hook.ts` — единственный вызов refresh при старте приложения, дедуп с auth-middleware.
      *Закрыто 2026-07-29:* хук `useBootstrapSession` +
      `packages/client/src/units/auth/lib/session-refresh.util.ts` — общий шлюз ротации, через
      который ходят и bootstrap, и auth-middleware, поэтому 401 во время восстановления сессии
      присоединяется к уже идущему обмену, а не начинает второй (второй — это reuse detection).
- [x] Реализовать `units/auth/lib/guards/require-session.ts` и `redirect-if-authed.ts`, подключить к `_authenticated.tsx` и `login.tsx`.
      *Закрыто ревизией 2026-07-28:* сделано в EPIC-004 —
      `packages/client/src/units/auth/lib/guards/require-session.guard.ts` и
      `.../redirect-if-authed.guard.ts` (имена с role-суффиксом по `rules/naming-and-structure.mdc`),
      подключены как `beforeLoad` в `packages/client/src/app/routes/_authenticated.tsx:16` и
      `packages/client/src/app/routes/login.tsx:17`, покрыты `packages/client/test/routes/guards.test.ts`.
      *Дополнено 2026-07-29:* остававшийся пробел («контекстом никто не управляет») закрыт —
      `packages/client/src/app/router-auth.util.ts` отдаёт `auth.status` геттером поверх стора,
      а `redirectIfAuthed` теперь тратит `search.redirect`, то есть является обратным ходом входа.
- [x] Реализовать Zod-схему `loginSearchSchema` с валидацией `redirect`: только относительные пути внутри приложения.
      *Закрыто ревизией 2026-07-28:* `packages/client/src/units/auth/model/validation/login-search.schema.ts:23`,
      используется как `validateSearch` в `packages/client/src/app/routes/login.tsx:16`; отбрасывание
      внешнего `redirect` проверяется в `packages/client/test/routes/guards.test.ts`.
- [x] Прокинуть `auth` в контекст роутера (`createRouter({ context: { queryClient, auth } })`) и обеспечить `router.invalidate()` на события шины аутентификации.
      *Закрыто 2026-07-29:* `packages/client/src/app/router.tsx` собирает контекст один раз с
      `routerAuth`; `packages/client/src/app/auth-events.util.ts` подписан на шину и превращает
      `logged-in` в `router.invalidate()`, а `logged-out` — в навигацию и очистку кеша. Подписку
      ставит `main.tsx`. Контекст больше не передаётся пропом `RouterProvider`: перепроверка гардов
      стала осознанным действием, а не побочным эффектом рендера.
- [x] Реализовать полную очистку `queryClient` при logout и при смене пользователя.
      *Закрыто 2026-07-29:* `queryClient.clear()` в подписчике `logged-out`, **после** навигации на
      `/login` — иначе наблюдатели ещё смонтированного защищённого экрана мгновенно перезапросят
      всё, что было в кеше, пачкой 401.
- [x] Добавить экран загрузки приложения (использует скелетоны из [EPIC-007](../../epic-007-design-system/epic.md)).
      *Закрыто 2026-07-29:* `packages/client/src/app/ui/app-loading.component.tsx` —
      `SharedUi.TextSkeleton` внутри `role="status"` `aria-busy` `aria-live="polite"` и скрытое
      сообщение-ключ. `App` не монтирует роутер, пока статус `unknown`, поэтому кадра с формой входа
      не существует.

## Definition of Done

- [x] Тесты написаны первыми (TDD), проходят, изменённый код покрыт — 405 тестов клиента, покрытие
      100 % строк и ветвей (порог `coverage-baseline.json` для `packages/client` — 100/100)
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [x] a11y-проверка: экран загрузки объявлен как `aria-busy`/live-region, фокус после редиректа переносится на заголовок целевой страницы
      *2026-07-29:* экран загрузки — `role="status"` + `aria-busy` + `aria-live="polite"`; форма
      входа проходит `axe` без нарушений, ошибка поля связана через `aria-describedby` +
      `aria-invalid`, фокус после отказа встаёт на поле, весь путь проходится с клавиатуры (проверено
      и в тестах, и в браузере). Перевод фокуса на `h1` после навигации остаётся за
      `widgets/route-announcer` из EPIC-004.
- [ ] i18n: строки в обоих языках, хардкода нет — в JSX только ключи (`auth.login.*`, `nav.signOut`,
      `app.loading`, `validation.*`); каталоги EN/RU приходят в EPIC-008

## Ссылки

- Документация: [`ux-architecture.md` → Гарды в `beforeLoad`, Клиентская проверка — только подсказка](../../../docs/architecture/ux-architecture.md), [ADR-0007](../../../docs/architecture/adr/0007-tanstack-router-and-query.md)
- Правила: `rules/frontend-fsd.mdc`, `rules/security.mdc`
