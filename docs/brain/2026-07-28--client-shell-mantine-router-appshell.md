---
date: 2026-07-28
project: bad-crm
tags: [mantine, tanstack-router, css-modules, trusted-types, csp, a11y, fsd, vitest]
---

# Оболочка клиента: Mantine-тема, TanStack Router, AppShell (STORY-004-03 / 05 / 07)

## Простым языком

1. **Подключил дизайн-систему Mantine и завёл проектную тему** — палитру `brand`, шкалы, семантические
   токены `--bc-*` (поверхность, границы, текст, фокус, плотность, длительности анимаций). Зачем:
   чтобы каждый экран брал цвет и отступ из одного словаря, а тёмная тема была не вторым набором
   классов, а значением того же токена.
2. **Проверил контраст не глазами, а тестом** — тест читает сам файл токенов и считает контраст для
   обеих тем. Зачем: цвет, который «выглядит нормально», может не проходить норму для читаемости, и
   заметить это иначе невозможно.
3. **Установил Trusted-Types-политику до первого рендера.** Зачем: под боевой политикой безопасности
   без неё приложение не монтируется вообще — чёрный экран, при зелёных тестах.
4. **Закрыл шов уведомлений**: единый тостер поверх Mantine, ошибка мутации даёт ровно один тост, а
   повтор той же ошибки обновляет его, а не копит стопку.
5. **Подключил роутер с файловыми маршрутами, гардом на защищённую ветку и экранами состояний**
   (загрузка, ошибка, «страница не найдена»). Зачем: пользователь никогда не должен видеть белый
   экран, а ссылка на несуществующий путь не должна компилироваться.
6. **Собрал оболочку**: боковая навигация, шапка, переключатель темы, хлебные крошки, ссылка «к
   содержимому», объявление смены страницы для скринридера.
7. **Проверил всё в браузере под настоящим заголовком безопасности** — и нашёл два дефекта, которых
   тесты не видели: безымянный ориентир навигации и заблокированный стиль блокировки прокрутки.
8. **Прогнал сборку с бюджетом размера**: первый экран — 185 КБ из разрешённых 250 КБ.

## Технически

1. `packages/client/package.json` — Mantine `9.5.0` (`@mantine/core`, `hooks`, `notifications`),
   `@tanstack/react-router@1.170`, `@tanstack/router-plugin@1.168` (dev), `@tabler/icons-react`,
   `clsx`, `postcss-preset-mantine`, `postcss-simple-vars`, `axe-core`, `@testing-library/user-event`.
   **Расхождение со спекой:** ADR-0006, `stack.md` и `CLAUDE.md` называют Mantine **7**; в реестре
   latest stable — **9.5.0** (7.17.8 помечен `legacy`), а официальный MCP `mantine` документирует
   именно текущую версию. Ставить 7 значило бы писать по памяти при живом MCP — правило «сначала
   MCP» этого не допускает. Требуется правка ADR-0006/`stack.md` или явное решение вернуться на 7.
   **Закрыто (2026-07-28):** решение — проект на Mantine 9. ADR-0006 получил датированную поправку
   «Мажорная версия Mantine» (решение не переписано, зафиксировано, что изменилось и почему);
   `stack.md`, `overview.md`, `roadmap.md`, `ux-architecture.md`, ADR-0005, `rules/design-system.mdc`,
   `rules/dependencies.mdc` и `CLAUDE.md` приведены к 9.
2. `src/app/theme/app-theme.config.ts` — `createTheme` c `BRAND_COLORS`, `primaryShade:
   { light: 6, dark: 8 }` (белый текст на кнопке даёт 4.63:1 и 7.08:1), `lineHeights ≥ 1.5`.
   Имя файла — не `theme.ts`: `bad-crm/require-role-suffix` требует роль-суффикс.
3. `src/app/styles/tokens.css` — `@mixin light-root` / `@mixin dark-root`, **не** `light-dark()`:
   `postcss-preset-mantine` компилирует `light-dark()` в потомковый селектор, и на `:root` тёмная
   половина превратилась бы в `[data-mantine-color-scheme='dark'] :root`, который не совпадает ни с
   чем. `--bc-text-muted` в светлой теме — `gray-7`, а не `gray-6` из `ux-architecture.md`:
   измеренный контраст `gray-6` на белом = 3.32:1 < 4.5:1. **Документ требует правки.**
   **Закрыто (2026-07-28):** `ux-architecture.md` → «Дизайн-система → Токены» приведён к коду
   (`gray-7` / `dark-1`) с поправкой, в которой названо, что ошибка была в спецификации, а не в
   реализации. Тем же расчётом проверены остальные пары блока — вторая половина того же токена
   (`dark-2` на `dark-7` = 4.03:1) тоже не проходила и исправлена.
   **Механика закрыта (2026-07-28):** сниппеты токенов в `ux-architecture.md`, ADR-0006 («Решение»)
   и `rules/design-system.mdc` §4 переписаны на `@mixin light-root` / `@mixin dark-root`; различие
   «`:root` — миксины, `*.module.css` — `light-dark()`» названо явно, чтобы следующий не скопировал
   нерабочий вариант.

   **Открыто (найдено 2026-07-28 при сверке):** сам `tokens.css` объявляет миксины на **верхнем
   уровне** файла, а официальная документация `postcss-preset-mantine` вкладывает их в `:root`.
   Миксин разворачивается в `&[data-mantine-color-scheme='…']`, поэтому без внешнего `:root` в
   собранный CSS попадает голый `&`-селектор. Проверено прогоном настоящего файла через
   `postcss-preset-mantine@1.18.0`. Правка — в коде (`packages/client/src/app/styles/tokens.css`),
   не в документе.
4. `src/app/trusted-types.util.ts` — политика `default` только с `createHTML`, отвергающим строки с
   `<`/`>`; `createScript`/`createScriptURL` не определены (ADR-0023). Вызывается в `main.tsx` до
   `createRoot`.
5. `src/app/style-nonce.util.ts` — `styleNonce()` читает `<meta name="csp-nonce">` (шов: подстановку
   делает процесс, отдающий `index.html`; сейчас его нет), `installStyleNonce()` публикует значение в
   `globalThis.__webpack_nonce__`. Второе добавлено **по факту нарушения в браузере**: `Drawer`
   блокирует прокрутку через `react-remove-scroll`, который пишет свой `<style>` мимо
   `getStyleNonce`, и он был заблокирован `style-src-elem` (ADR-0023 просил проверить «при первой
   модалке»).
6. `src/shared/ui/toaster/notify.util.ts` — реализация `NotificationPort`; `Set` живых `id`,
   `notifications.update` вместо второго `show`, `role=alert`/`aria-live=assertive` для ошибок.
   Подключён в `src/app/app-query-client.constant.ts` вместо `silentNotifications`.
7. `src/app/router.tsx` — `createAppRouter(context, history?)`, `defaultPreload: 'intent'`,
   `defaultPreloadStaleTime: 0`, `defaultPendingMs: 200`, три граничных компонента, `declare module`
   с `Register` и `StaticDataRouteOption.crumbKey`. Маршруты: `__root`, `_authenticated`,
   `_authenticated/index` (redirect), `_authenticated/dashboard`, `_authenticated/$` (404 внутри
   оболочки), `login`.
8. `validateSearch` принимает Zod-схему напрямую: `@tanstack/zod-adapter` объявляет peer
   `zod@^3.23.8`, воркспейс на `zod@4.4.3`, а роутер принимает Zod 4 как standard-schema.
9. `src/app/guards/*` и `src/app/search/*` — каноническое место `units/auth/lib/guards` и
   `shared/lib/validation`; вынесено в `app/`, потому что `units/**` и `shared/{api,lib,config}/**`
   вне границы этой задачи. Переезд — STORY-006-05 и первый доменный unit.
   **Закрыто (2026-07-28):** переезд выполнен в этом же эпике, не в STORY-006-05. Гарды лежат в
   `src/units/auth/lib/guards/`, схема списков — в `src/shared/lib/validation/list-search.schema.ts`;
   каталогов `src/app/guards` и `src/app/search` больше нет.
10. `src/widgets/app-shell/**` — Mantine `AppShell`; мобильная навигация — `Drawer` (ловушка фокуса,
    `Esc`, возврат фокуса), а не свёрнутый navbar. Ориентир `<nav>` объявляет **хозяин** списка:
    `AppShell.Navbar` сам является `<nav>`, поэтому `SidebarNav` рендерит `Box` — иначе два
    вложенных ориентира, внешний безымянный (найдено в браузере, закрыто тестом).
11. `src/widgets/route-announcer/**` — `useDocumentTitle` + перевод фокуса на `h1` при смене
    маршрута. Сравнение с предыдущим `crumbKey` через `useRef(titleKey)`, а не флаг «первый рендер»:
    под `StrictMode` (а он включён в `main.tsx`) флаг переживал remount и фокус уезжал на `h1` при
    обычной загрузке, унося skip-link за пределы первого `Tab`.
12. Гейты: `eslint.config.js` — `app/**` отделён от `pages/widgets` (импорт дата-слоя разрешён,
    вызов query-хуков нет), `shared/ui/**` добавлен в `CLIENT_UI` (jsx-a11y), `@mantine/notifications`
    запрещён вне `shared/ui/toaster` + `app/providers.tsx`/`main.tsx`, `only-throw-error` сужен для
    `redirect()`, `app/routes/**` освобождён от роль-суффикса. `test/architecture/structure.test.ts`
    — то же исключение и проверка, что оно не шире.
13. Покрытие клиента 100/100 при пороге-храповике; из `include` исключены `route-tree.gen.ts` и
    `app/routes/**` (v8 стабильно считает непокрытой закрывающую строку `createFileRoute(...)({…})`
    — измерено с `autoCodeSplitting` и без него).

## Применённые технологии

- [[Mantine]] — UI-kit, тема, `AppShell`, `Drawer`, `Notifications`; API сверялся через официальный MCP.
- [[TanStack Router]] — file-based маршруты, гарды `beforeLoad`, типизированные search-параметры.
- [[TanStack Query]] — `QueryClientProvider` в композиционном корне, порт уведомлений.
- [[Zod]] — схемы search-параметров, защита от open redirect в `?redirect=`.
- [[CSS Modules]] + [[PostCSS]] (`postcss-preset-mantine`) — стили и токены.
- [[Trusted Types]] / [[Content Security Policy]] — политика `default`, nonce для `<style>`.
- [[Vitest]] + [[Testing Library]] + [[axe-core]] — тесты, включая a11y и контраст токенов.
- [[size-limit]] — бюджет бандла.

## Связи

- Проект: [[Projects/bad-crm]]
- Related: [[ADR-0006]], [[ADR-0007]], [[ADR-0023]], [[docs/architecture/ux-architecture]]
