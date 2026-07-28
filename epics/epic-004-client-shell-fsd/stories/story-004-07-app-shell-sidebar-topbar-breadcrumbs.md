---
id: STORY-004-07
epic: EPIC-004
status: review
blocked: false
priority: must
estimate: M
---

# STORY-004-07 — Оболочка: сайдбар, шапка, переключатель организации, хлебные крошки

**Как** разработчик (пользователь продукта) **я хочу** постоянную оболочку приложения с навигацией,
шапкой и хлебными крошками **чтобы** всегда понимать, где я нахожусь, и переключаться между
разделами без потери контекста.

## Acceptance (Given/When/Then)

- **Given** авторизованный пользователь на ширине ≥ 992 px **When** открыт любой защищённый маршрут **Then** видны постоянный сайдбар с блоками «Личное», «Работа команды», «Delivery», «Администрирование», шапка и область контента; активный пункт подсвечен по текущему маршруту.
- **Given** сайдбар **When** сворачиваю его в иконки **Then** состояние сохраняется в `localStorage` и восстанавливается после перезагрузки; у каждой иконки есть доступное имя.
- **Given** ширина < 768 px **When** открываю приложение **Then** сайдбар превращается в `Drawer` по кнопке-бургеру, фокус при открытии переходит внутрь, `Esc` закрывает, фокус возвращается на бургер.
- **Given** вложенный маршрут (например, раздел настроек) **When** он открыт **Then** хлебные крошки строятся из дерева маршрутов, последний элемент не является ссылкой, а `h1` страницы совпадает с последней крошкой.
- **Given** пользователь, состоящий в двух организациях **When** он выбирает другую организацию в переключателе **Then** выполняется полная перезагрузка приложения (кеш и права меняются целиком), после чего он оказывается на `/dashboard` новой организации.
- **Given** пользователь ровно в одной организации **When** он открывает подвал сайдбара **Then** переключатель не показывается (или показан как неинтерактивная метка) — лишний контрол не отображается.
- **Given** клавиатура **When** нажимаю `Tab` от начала страницы **Then** первым фокусируемым элементом является skip-link «К основному содержимому», ведущий на `<main>`.
- **Given** оболочка **When** прогоняется автоматический a11y-аудит (axe) **Then** нарушений уровня A и AA нет: используются `<nav>`, `<main>`, `<header>`, корректные ориентиры и `aria-current` на активном пункте.

## Задачи

- [ ] Написать тесты первыми: `widgets/app-shell/app-shell.widget.test.tsx` (структура ориентиров, активный пункт, skip-link), `widgets/app-shell/sidebar.test.tsx` (сворачивание и персист, мобильный drawer, фокус-ловушка), `widgets/breadcrumbs/breadcrumbs.test.tsx` (построение из дерева маршрутов), `units/organization/…/org-switcher.test.tsx` (перезагрузка при смене, скрытие при одной организации).
      — **частично:** написаны и проходят `packages/client/test/widgets/app-shell.test.tsx`
      (ориентиры и их именование, отсутствие вложенных `nav`, ровно один `main`/`banner`, axe-аудит
      оболочки, skip-link первым по `Tab`, `aria-current`, сворачивание с персистом, именование
      свёрнутых пунктов, мобильный `Drawer` с ловушкой фокуса и возвратом по `Esc`) и
      `packages/client/test/widgets/breadcrumbs.test.tsx`. Тесты сайдбара не выделены в отдельный
      файл — они лежат блоками `describe('the sidebar')` / `describe('the mobile drawer')` в
      `app-shell.test.tsx`, потому что проверяют один и тот же смонтированный виджет.
      `org-switcher.test.tsx` **не написан** и переносится вместе с самим переключателем — см.
      задачу про `units/organization` ниже.
- [x] Реализовать `src/widgets/app-shell/app-shell.widget.tsx` на Mantine `AppShell` с областями header/navbar/main и режимом плотности.
- [x] Реализовать `src/widgets/app-shell/ui/sidebar-nav.component.tsx` — структура разделов из [`ux-architecture.md`](../../../docs/architecture/ux-architecture.md), `aria-current`, сворачивание.
- [x] Реализовать `src/widgets/app-shell/ui/topbar.component.tsx` — места под глобальный поиск (`Cmd+K`), переключатель проекта, таймер, уведомления и AI (в M1 — заглушки, скрытые за фича-флагами).
- [x] Реализовать `src/widgets/breadcrumbs/breadcrumbs.widget.tsx` поверх `useMatches()` роутера.
- [ ] Реализовать `src/units/organization/ui/organization-switcher.component.tsx` + хук `use-organization-switch.hook.ts` (полная перезагрузка через `window.location.assign`).
      — **не выполнено, перенесено в [STORY-006-05](../../epic-006-auth-core/stories/story-006-05-client-session-bootstrap-and-guards.md)**:
      юнита `units/organization` нет, и завести его сейчас не из чего. Переключателю нужен список
      организаций пользователя, а он приходит с сессией, которой ещё не существует: контекст роутера
      (`src/app/router-context.types.ts`) несёт только `auth.status`, а самого bootstrap сессии нет
      до EPIC-006. Переключатель из пустого списка — это либо заглушка с фейковыми данными
      (запрещено `rules/commit-hygiene.mdc`), либо контрол, который по критерию приёмки этой же
      истории не должен показываться. Оба критерия приёмки про переключатель
      (смена организации → полная перезагрузка на `/dashboard`; одна организация → контрол скрыт)
      проверяются там же.
      **Подтверждено открытым (2026-07-28):** `packages/client/src/units/` содержит `auth`,
      `dashboard`, `session` — юнита `organization` нет; `src/app/router-context.types.ts` по-прежнему
      несёт только `auth`.
- [x] Реализовать skip-link и правильный порядок ориентиров в `__root.tsx`.
- [ ] Вынести все подписи навигации в namespace `nav.json` (EN/RU) — см. [EPIC-008](../../epic-008-i18n-en-ru/epic.md).
      — **частично:** подписи уже являются ключами, а не строками
      (`widgets/app-shell/model/nav-sections.constant.ts`: `nav.section.personal`, `nav.dashboard`
      и т. д.), хардкод-строк в оболочке нет. Самого namespace `nav.json` в EN и RU нет — он
      заводится в [STORY-008-01](../../epic-008-i18n-en-ru/stories/story-008-01-i18next-setup-and-namespaces.md)
      вместе с инфраструктурой i18next.

## Definition of Done

- [x] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [x] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [x] Документация обновлена (docs/ + запись в `docs/brain/`)
- [x] a11y-проверка: axe без нарушений A/AA, полная работа с клавиатуры, видимый фокус, ловушка фокуса в drawer
- [ ] i18n: строки в обоих языках, хардкода нет — **частично:** хардкод-строк нет, всё через ключи (см. задачу про `nav.json` выше); каталогов EN/RU нет — [STORY-008-01](../../epic-008-i18n-en-ru/stories/story-008-01-i18next-setup-and-namespaces.md). **Подтверждено открытым (2026-07-28):** каталогов нет — `packages/client/src/shared/i18n` не существует

## Ссылки

- Документация: [`ux-architecture.md` → Информационная архитектура, Каркас приложения, Доступность](../../../docs/architecture/ux-architecture.md), [`prd.md` → NFR-7](../../../docs/product/prd.md)
- Правила: `rules/frontend-fsd.mdc`, `rules/a11y.mdc`, `rules/i18n.mdc`
