---
id: STORY-004-03
epic: EPIC-004
status: review
blocked: false
priority: must
estimate: M
---

# STORY-004-03 — MantineProvider, тема, CSS Modules, светлая и тёмная темы

**Как** разработчик Bad CRM **я хочу** настроенную тему Mantine и стилизацию через CSS Modules
**чтобы** интерфейс выглядел однородно, тёмная тема работала везде, и не возникало войны каскадов
между разными способами стилизации.

## Acceptance (Given/When/Then)

- **Given** приложение обёрнуто в `MantineProvider` с проектной темой **When** оно рендерится **Then** доступны CSS-переменные `--mantine-*`, подключены `@mantine/core/styles.css` и стили используемых пакетов.
- **Given** переключатель темы `system | light | dark` **When** выбираю `dark` **Then** цвета меняются мгновенно без перезагрузки, выбор сохраняется между сессиями, а при `system` применяется `prefers-color-scheme`.
- **Given** CSS-модуль с литеральным цветом `#1971c2` или отступом `12px` **When** запускается линт стилей **Then** он падает: используются только токены (`var(--mantine-color-*)`, `var(--mantine-spacing-*)`) и `light-dark()`.
- **Given** компонент со стилем `style={{ marginTop: 12 }}` **When** запускается линт **Then** он падает: отступы задаются `Stack`/`Group` или классом CSS-модуля.
- **Given** `postcss-preset-mantine` **When** в CSS-модуле используется `@media (max-width: $mantine-breakpoint-sm)` **Then** миксин разворачивается корректно; магические пиксели в медиазапросах запрещены линтером.
- **Given** тёмная тема **When** проверяю контраст ключевых пар (текст на поверхности, текст на кнопке, ссылка) **Then** он ≥ 4.5:1 (≥ 3:1 для крупного) — проверяется автоматическим тестом контраста по токенам.
- **Given** `prefers-reduced-motion: reduce` **When** воспроизводится любая анимация каркаса **Then** она сводится к мгновенной смене состояния.
- **Given** необходимость подключить компонент или хук Mantine **When** разработчик готовится писать код **Then** API сверяется через официальный MCP `mantine`, а не по памяти (зафиксировано в правиле и в шаблоне PR).

## Задачи

- [x] Написать тесты первыми: `test/theme/tokens.test.ts` (наличие обязательных семантических токенов, контраст пар в обеих темах), `test/theme/color-scheme.test.tsx` (переключение и персист), `test/lint/styles.test.ts` (запрет литеральных цветов и пикселей в `*.module.css`).
- [x] Реализовать `src/app/theme/theme.ts`: палитра `brand`, шкалы spacing/radius/font-size, `defaultRadius`, `headings`, `components` с дефолтными пропсами.
      *Уточнение (2026-07-28):* файл называется `src/app/theme/app-theme.config.ts` — role-суффикс
      обязателен по `rules/naming-and-structure.mdc` и проверяется `bad-crm/require-role-suffix`.
      `defaultRadius: 'sm'` задан **явно**: в Mantine 9 дефолт сменился на `md`.
- [x] Реализовать `src/app/styles/tokens.css` с семантическими алиасами (`--bc-surface`, `--bc-surface-raised`, `--bc-border`, `--bc-text`, `--bc-text-muted`, `--bc-danger-surface`, `--bc-motion-fast`, `--bc-motion-base`, `--bc-row-height`) через `light-dark()`.
      *Уточнение (2026-07-28):* на `:root` схемы объявляются миксинами `@mixin light-root` /
      `@mixin dark-root`, а **не** `light-dark()` — `postcss-preset-mantine` документирует, что
      `light-dark()` «does not work on `:root`/`html` element» (компилируется в потомковый селектор,
      и тёмная половина превращается в `[data-mantine-color-scheme='dark'] :root`, который не
      совпадает ни с чем). Внутри `*.module.css` компонента `light-dark()` остаётся штатным
      способом — это различие зафиксировано в `rules/design-system.mdc` §4 и в
      `ux-architecture.md` → «Дизайн-система → Токены». Оба миксина **вложены внутрь `:root`**:
      миксин дописывает к объемлющему правилу, и на верхнем уровне файла он раскрывался в
      `&[data-mantine-color-scheme='light']` вместо `:root[…]`. Работало (корневой `&` резолвится
      как `:scope`), но держалось на тонкости спецификации и на том, во что цель сборки понизит
      `&`. Проверяет **собранный** CSS `test/styles/scheme-selectors.test.ts` — остальные проверки
      темы читают исходник и этого класса дефектов не видят вовсе.
- [ ] Реализовать `src/app/providers.tsx` с `MantineProvider`, `ColorSchemeScript` в `index.html`, `defaultColorScheme="auto"`. — **частично:** `MantineProvider` и `defaultColorScheme="auto"` на месте (`src/app/providers.tsx`); **`ColorSchemeScript` в `index.html` отсутствует**, и это не бухгалтерия, а измеренный дефект. Замер 2026-07-28 на production-сборке с задержкой отдачи `*.js`: при системной светлой теме и сохранённым в `localStorage` выбором `dark` до гидратации виден **белый** кадр (`#f4f4f4`, чёрный текст), атрибут `data-mantine-color-scheme` выставляется на 43 мс — то есть 20–45 мс вспышки на быстрой машине и пропорционально дольше на медленной. В режиме `auto` вспышки нет, но по случайности: тематических переменных под `@media (prefers-color-scheme)` в собранном CSS нет, холст до гидратации красит UA по `color-scheme: light dark`, и он совпадает с системной темой. Сохранённый выбор для CSS невидим до запуска JS. **Закрывается не здесь:** нужен инлайновый `<script>` в `<head>`, а CSP по [ADR-0023](../../../docs/architecture/adr/0023-csp-for-wasm-crypto.md) запрещает `'unsafe-inline'`; nonce (или `'sha256-…'`) подставляет процесс, отдающий `index.html`, а его не существует — сегодня документ отдаёт Vite, к которому заголовок CSP вообще не применяется. Отдача SPA появляется в [EPIC-017](../../epic-017-self-host-alpha/epic.md) (образ приложения и reverse-proxy); отдельной истории под неё пока нет — завести на kickoff M2 вместе с `docker-compose.prod.yml`.
- [x] Реализовать `units/appearance` (или `shared/hooks/use-color-scheme.hook.ts`) с сохранением выбора в `localStorage` и последующей синхронизацией с профилем (профиль — [EPIC-012](../../epic-012-employee-management/epic.md)).
- [x] Настроить `postcss.config.cjs` с `postcss-preset-mantine` и `postcss-simple-vars` для брейкпоинтов.
- [x] Настроить `stylelint` с правилами: запрет литеральных цветов/размеров, требование логических свойств (`margin-inline-start` вместо `margin-left`).
      `stylelint.config.js` в корне, скрипт `pnpm stylelint`: `color-no-hex`/`color-named` +
      `declaration-property-value-disallowed-list` (функциональные цвета и «магические» `px`, кроме
      `0px`/`1px`), `property-disallowed-list` на физические свойства. Синтаксис
      `postcss-preset-mantine` (`@mixin light-root`, `rem()`/`em()`, `$mantine-breakpoint-*`) учтён
      в конфиге, а не заглушен. Сам конфиг проверен на заведомо битом CSS
      (`test/lint/stylelint-rules.test.ts`) — линтер, который никогда не срабатывает, выключен.
- [x] Добавить режим плотности `comfortable | compact` классом на оболочке и переменной `--bc-row-height`.

## Definition of Done

- [x] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [x] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [x] Документация обновлена (docs/ + запись в `docs/brain/`)
- [x] a11y-проверка: контраст в обеих темах, уважение `prefers-reduced-motion`, видимый фокус
- [ ] i18n: строки в обоих языках, хардкода нет — подписи переключателя темы вынесены в ключи — **частично:** ключи проставлены (`common.appearance.colorScheme.{auto,light,dark}` в `shared/hooks/use-color-scheme.hook.ts`, `common.appearance.colorScheme.aria` в `widgets/app-shell/ui/color-scheme-control.component.tsx`), хардкод-строк нет; каталогов EN/RU и функции перевода ещё не существует — заводятся в [STORY-008-01](../../epic-008-i18n-en-ru/stories/story-008-01-i18next-setup-and-namespaces.md). **Подтверждено открытым (2026-07-28):** каталогов нет — `packages/client/src/shared/i18n` не существует

## Ссылки

- Документация: [`ux-architecture.md` → Дизайн-система, Токены](../../../docs/architecture/ux-architecture.md), [ADR-0006](../../../docs/architecture/adr/0006-mantine-css-modules-no-tailwind.md), [`prd.md` → NFR-7](../../../docs/product/prd.md)
- Правила: `rules/design-system.mdc`, `rules/a11y.mdc`
