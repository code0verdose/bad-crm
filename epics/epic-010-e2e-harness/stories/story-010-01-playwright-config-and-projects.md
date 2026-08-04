---
id: STORY-010-01
epic: EPIC-010
status: review
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

- [x] Написать первым «мета-тест» конфигурации: `packages/e2e/test/config.test.ts` — проверяет наличие `webServer`/ожидания готовности, отсутствие `waitForTimeout` в спеках, корректные значения `retries` для CI и локали запуска.
- [x] Создать `packages/e2e/playwright.config.ts`: `baseURL`, проекты браузеров, `use.trace: 'on-first-retry'`, `screenshot: 'only-on-failure'`, `video: 'retain-on-failure'`, таймауты.
- [x] Реализовать ожидание готовности приложения через опрос `/ready` перед стартом сценариев.
- [x] Настроить скрипты `pnpm test:e2e`, `test:e2e:ui`, `test:e2e:debug` и включить задачу в `turbo.json` с `cache: false`.
- [x] Добавить ESLint-правило для пакета `e2e`: запрет `waitForTimeout`, запрет импорта из `@bad-crm/server` и `@bad-crm/client`.
- [x] Настроить структуру каталогов: `tests/smoke`, `tests/auth`, `tests/tenancy`, `fixtures/`, `pages/` (page objects).
- [x] Описать в `docs/runbooks/e2e.md` порядок локального запуска и отладки.

## Definition of Done

- [x] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [x] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [x] Документация обновлена (docs/ + запись в `docs/brain/`)
- [x] a11y-проверка (для UI-историй) — подключение axe выполняется в [STORY-010-04](story-010-04-smoke-register-login-logout.md)
- [x] i18n: строки в обоих языках, хардкода нет (для UI-историй) — селекторы не завязаны на текст конкретной локали

## Ссылки

- Документация: [`stack.md` → Тестовая стратегия](../../../docs/architecture/stack.md), [`stack.md` → Раскладка монорепо (e2e не зависит от исходников)](../../../docs/architecture/stack.md)
- Правила: `rules/testing.mdc`

## Что сделано (запись истории)

- `packages/e2e/playwright.config.ts` — `testDir: ./tests`, `fullyParallel`, `forbidOnly` и
  `retries` как функция `CI` (локально 0, в CI 1), матрица браузеров (`chromium`, полная — по
  `E2E_BROWSERS=all`), таймауты и базовый URL из окружения с локальными дефолтами, артефакты только
  у падений (`on-first-retry` / `only-on-failure` / `retain-on-failure`).
- `packages/e2e/global-setup.ts` — опрос `/ready` до готовности стека, с адресом API отдельно от
  `baseURL`: клиент проксирует только `/api`, и через `baseURL` проба недостижима.
- **Мета-тест живёт в корневом наборе** (`test/e2e/playwright-config.test.ts`), а не в
  `packages/e2e/test/`, как предполагала задача. Причина: контракт конфигурации — репозиторный
  инвариант того же рода, что `test/repo/**`, и корневой набор уже учитывает `inputs` турбо.
  Отдельный vitest внутри `e2e` добавил бы второй раннер пакету, у которого есть свой (Playwright),
  и попал бы под контракт покрытия из `test/repo/coverage-contract.test.ts`.
- **Найдено при работе:** `playwright.config.ts` и `global-setup.ts` лежат в корне пакета и не
  попадали ни под `include` его tsconfig, ни под ESLint-глоб (`packages/e2e/{src,tests}/**`) — оба
  файла были бы отгружены не типизированными и без единого правила, включая запрет импорта
  приложения. Исправлено и закрыто утверждением о **реальных** файлах через `configForRepoFile`
  (`test/lint/architecture-rules.test.ts`), а не только фикстурами.
- Запрет `waitForTimeout` — `no-restricted-syntax` в блоке e2e + фикстура
  `test/lint/fixtures/packages/e2e/tests/fixed-wait.spec.ts`.
- `rules/naming-and-structure.mdc`: `global-setup.ts` внесён в fixed-имена инструментов; пункт 4
  («`export default` запрещён, таких мест в проекте нет») перестал быть верным — Playwright читает
  конфигурацию и `globalSetup` только из default-экспорта, это записано.
- `docs/runbooks/e2e.md` — порядок запуска, установка браузеров отдельной командой, переменные
  окружения, чтение trace.
- Каталог `tests/` пока пуст (`.gitkeep`): спеки приходят со STORY-010-04, джоба CI — со STORY-010-06.
