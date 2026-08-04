---
id: STORY-047-01
epic: EPIC-047
status: review
blocked: false
priority: must
estimate: M
---

# STORY-047-01 — Пакет лендинга и его фундамент

**Как** посетитель сайта Bad CRM **я хочу** открыть страницу, которая мгновенно грузится, плавно
скроллится и говорит на моём языке **чтобы** решить, стоит ли разбираться с продуктом дальше.

## Acceptance (Given/When/Then)

- **Given** чистый клон **When** выполняю `pnpm --filter @bad-crm/landing dev` **Then** лендинг открывается и не тянет ни одного модуля из `packages/client`.
- **Given** пакет лендинга **When** смотрю его зависимости **Then** среди них нет `@bad-crm/*` и нет Mantine.
- **Given** страница **When** скроллю **Then** скролл плавный (Lenis), сверху идёт индикатор прогресса, шапка сжимается в «пилюлю» с blur-подложкой.
- **Given** `prefers-reduced-motion: reduce` **When** открываю страницу **Then** плавный скролл отключён, анимации не запускаются, содержимое читается статично.
- **Given** переключатель языка **When** выбираю RU **Then** весь интерфейс меняет язык, `<html lang>` обновляется, выбор переживает перезагрузку.
- **Given** словарь RU без одного ключа **When** запускается `tsc` **Then** сборка падает.
- **Given** CSS-модуль лендинга с литеральным цветом **When** запускается stylelint **Then** он падает; исключение — только файлы токенов лендинга.

## Задачи

- [x] Скелет пакета: `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `README.md` со статусом прототипа.
- [x] Блок `packages/landing/**` в корневом `eslint.config.js`; файлы токенов лендинга в исключениях `stylelint.config.js` и синхронная правка `test/lint/stylelint-rules.test.ts`.
- [x] Токены `--bcl-*` (тёмная база и светлая схема), типографика, сетка, `global.css`.
- [x] `lenis.provider.tsx`, `use-reduced-motion.hook.ts`, `use-scroll-progress.hook.ts`, `motion-presets.constant.ts`.
- [x] Словари `dictionary.en.ts` / `dictionary.ru.ts` (тип RU выводится из EN), `locale.provider.tsx`, `use-locale.hook.ts`.
- [x] Оболочка: шапка, футер, индикатор прогресса, переключатель языка, skip-link (переключателя тем нет: у лендинга одна схема, решение зафиксировано в `app/providers.tsx`).

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт — **порядок нарушен**: страница собиралась итерациями под живой просмотр, тесты (54, покрытие 94 % строк / 90 % веток по логике пакета) написаны после и до коммита; зафиксировано осознанно
- [x] Commit-гейт зелёный (test-coverage, security-auditor, production-readiness, commit-hygiene)
- [x] Документация обновлена (`docs/brain/`)
- [x] a11y: skip-link, видимый фокус, контраст, декоративные слои с `aria-hidden`
