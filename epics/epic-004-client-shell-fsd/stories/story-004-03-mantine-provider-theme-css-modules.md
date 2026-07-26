---
id: STORY-004-03
epic: EPIC-004
status: backlog
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

- [ ] Написать тесты первыми: `test/theme/tokens.test.ts` (наличие обязательных семантических токенов, контраст пар в обеих темах), `test/theme/color-scheme.test.tsx` (переключение и персист), `test/lint/styles.test.ts` (запрет литеральных цветов и пикселей в `*.module.css`).
- [ ] Реализовать `src/app/theme/theme.ts`: палитра `brand`, шкалы spacing/radius/font-size, `defaultRadius`, `headings`, `components` с дефолтными пропсами.
- [ ] Реализовать `src/app/styles/tokens.css` с семантическими алиасами (`--bc-surface`, `--bc-surface-raised`, `--bc-border`, `--bc-text`, `--bc-text-muted`, `--bc-danger-surface`, `--bc-motion-fast`, `--bc-motion-base`, `--bc-row-height`) через `light-dark()`.
- [ ] Реализовать `src/app/providers.tsx` с `MantineProvider`, `ColorSchemeScript` в `index.html`, `defaultColorScheme="auto"`.
- [ ] Реализовать `units/appearance` (или `shared/hooks/use-color-scheme.hook.ts`) с сохранением выбора в `localStorage` и последующей синхронизацией с профилем (профиль — [EPIC-012](../../epic-012-employee-management/epic.md)).
- [ ] Настроить `postcss.config.cjs` с `postcss-preset-mantine` и `postcss-simple-vars` для брейкпоинтов.
- [ ] Настроить `stylelint` с правилами: запрет литеральных цветов/размеров, требование логических свойств (`margin-inline-start` вместо `margin-left`).
- [ ] Добавить режим плотности `comfortable | compact` классом на оболочке и переменной `--bc-row-height`.

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y-проверка: контраст в обеих темах, уважение `prefers-reduced-motion`, видимый фокус
- [ ] i18n: строки в обоих языках, хардкода нет — подписи переключателя темы вынесены в ключи

## Ссылки

- Документация: [`ux-architecture.md` → Дизайн-система, Токены](../../../docs/architecture/ux-architecture.md), [ADR-0006](../../../docs/architecture/adr/0006-mantine-css-modules-no-tailwind.md), [`prd.md` → NFR-7](../../../docs/product/prd.md)
- Правила: `rules/design-system.mdc`, `rules/a11y.mdc`
