---
id: STORY-010-01
epic: EPIC-010
status: backlog
blocked: false
priority: must
estimate: M
---

# STORY-010-01 — Конфигурация Playwright и запуск против стека

**Как** разработчик Bad CRM **я хочу** готовую конфигурацию e2e, запускающуюся одной командой
против поднятого стека **чтобы** писать сценарии, а не настраивать окружение перед каждым тестом.

## Acceptance (Given/When/Then)

- **Given** поднятый `docker compose` и собранное приложение **When** выполняю `pnpm test:e2e` **Then** Playwright дожидается готовности приложения через `webServer`/`/ready` и выполняет сценарии; фиксированных `sleep` в конфигурации нет.
- **Given** конфигурация проектов **When** смотрю её **Then** объявлены `chromium` (обязателен на PR) и `firefox`/`webkit` (полный набор — по расписанию); выбор набора управляется переменной окружения.
- **Given** локальный запуск **When** тест падает **Then** `retries: 0` — падение видно сразу; в CI `retries: 1`, и повторно прошедший тест помечается как flaky.
- **Given** сценарий, ожидающий появления элемента **When** он выполняется **Then** используются авто-ожидания и веб-ассерты (`expect(locator).toBeVisible()`), а `waitForTimeout` запрещён линтом.
- **Given** пакет `packages/e2e` **When** проверяется его `package.json` и импорты **Then** он не зависит от исходников `server` и `client`: данные готовятся через публичный API и seed.
- **Given** параллельный прогон **When** он выполняется **Then** тесты не мешают друг другу: каждый использует собственные данные, созданные через API, либо read-only-фикстуры.
- **Given** конфигурация **When** смотрю базовый URL и таймауты **Then** они берутся из переменных окружения с разумными дефолтами для локального запуска.

## Задачи

- [ ] Написать первым «мета-тест» конфигурации: `packages/e2e/test/config.test.ts` — проверяет наличие `webServer`/ожидания готовности, отсутствие `waitForTimeout` в спеках, корректные значения `retries` для CI и локали запуска.
- [ ] Создать `packages/e2e/playwright.config.ts`: `baseURL`, проекты браузеров, `use.trace: 'on-first-retry'`, `screenshot: 'only-on-failure'`, `video: 'retain-on-failure'`, таймауты.
- [ ] Реализовать ожидание готовности приложения через опрос `/ready` перед стартом сценариев.
- [ ] Настроить скрипты `pnpm test:e2e`, `test:e2e:ui`, `test:e2e:debug` и включить задачу в `turbo.json` с `cache: false`.
- [ ] Добавить ESLint-правило для пакета `e2e`: запрет `waitForTimeout`, запрет импорта из `@bad-crm/server` и `@bad-crm/client`.
- [ ] Настроить структуру каталогов: `tests/smoke`, `tests/auth`, `tests/tenancy`, `fixtures/`, `pages/` (page objects).
- [ ] Описать в `docs/runbooks/e2e.md` порядок локального запуска и отладки.

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y-проверка (для UI-историй) — подключение axe выполняется в [STORY-010-04](story-010-04-smoke-register-login-logout.md)
- [ ] i18n: строки в обоих языках, хардкода нет (для UI-историй) — селекторы не завязаны на текст конкретной локали

## Ссылки

- Документация: [`stack.md` → Тестовая стратегия](../../../docs/architecture/stack.md), [`stack.md` → Раскладка монорепо (e2e не зависит от исходников)](../../../docs/architecture/stack.md)
- Правила: `rules/testing.mdc`
