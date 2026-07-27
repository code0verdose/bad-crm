---
id: STORY-001-01
epic: EPIC-001
status: done
blocked: false
priority: must
estimate: M
---

# STORY-001-01 — pnpm workspaces и turborepo pipeline

**Как** разработчик Bad CRM **я хочу** один репозиторий с четырьмя пакетами и общим кешируемым
pipeline **чтобы** запускать сборку, типизацию, линт и тесты всего проекта одной командой и не
ждать повторно то, что уже собрано.

## Acceptance (Given/When/Then)

- [x] **Given** чистый клон репозитория и Node 22 **When** выполняю `pnpm install` **Then** устанавливаются зависимости четырёх пакетов (`shared`, `server`, `client`, `e2e`), Corepack подтягивает версию pnpm из поля `packageManager`, посторонних `node_modules` в корне пакетов не появляется.
- [x] **Given** установленные зависимости **When** выполняю `pnpm build` **Then** `packages/shared` собирается раньше `server` и `client` (за счёт `dependsOn: ["^build"]`), а в выводе turbo видно порядок задач.
- [x] **Given** успешный `pnpm build` **When** повторяю `pnpm build` без изменений файлов **Then** turbo восстанавливает результат из кеша и сообщает `FULL TURBO`, время прогона меньше 5 секунд. *(проверено 2026-07-27: `8ms >>> FULL TURBO`, холодная сборка — 1,4 с.)*
- [x] **Given** изменённый файл в `packages/shared` **When** выполняю `pnpm typecheck` **Then** кеш `shared`, `server` и `client` инвалидируется, а кеш `e2e` — нет. *(проверено 2026-07-27 правкой `packages/shared/src/index.ts`: `shared:build`, `shared:typecheck`, `server:typecheck`, `client:typecheck` — cache miss; `e2e:typecheck` — cache hit.)*
- [x] **Given** задача `test:e2e` или любая задача, трогающая БД **When** запускаю её дважды подряд **Then** она выполняется заново оба раза (`cache: false`), потому что результат зависит от внешнего состояния.
- [x] **Given** попытка импортировать `packages/server/src/...` из `packages/e2e` **When** запускаю `pnpm lint` **Then** линт падает с сообщением о нарушении направления зависимостей. *(фикстура `test/lint/fixtures/packages/e2e/src/app-source.spec.ts` в `test/lint/architecture-rules.test.ts`.)*
- [x] **Given** попытка импортировать что-либо из `packages/client` внутри `packages/shared` **When** запускаю `pnpm typecheck` **Then** сборка падает: `shared` не зависит ни от одного пакета репозитория.

## Задачи

- [x] Написать тест на раскладку и границы: `test/repo/workspace-layout.test.ts` — проверяет наличие четырёх пакетов в `pnpm-workspace.yaml`, отсутствие запрещённых зависимостей в `package.json` каждого пакета (`shared` без зависимостей на `@bad-crm/*`, `e2e` без `server`/`client`).
- [x] Создать корневой `package.json`: `packageManager: "pnpm@9.x.x"`, `engines.node: ">=22.11 <23"`, скрипты-обёртки `dev`, `build`, `typecheck`, `lint`, `test`, `test:integration`, `test:e2e`, `docker:up`, `docker:down`. *Отклонение: зафиксированы `pnpm@10.34.5` и `node >=22.22.1 <23` — floor подняли `lint-staged@17` и `@commitlint/cli@21`, которые ниже 22.22.1 не запускаются; проверяется `test/repo/toolchain-versions.test.ts`.*
- [x] Создать `pnpm-workspace.yaml` с `packages: ["packages/*"]` и `.npmrc` (`strict-peer-dependencies=false` при необходимости, `onlyBuiltDependencies` allow-list в корневом `package.json`).
- [x] Создать `turbo.json` с задачами `build` (`outputs: ["dist/**"]`), `typecheck`, `lint`, `test` (`outputs: ["coverage/**"]`), `test:e2e` (`cache: false`), `db:migrate` (`cache: false`), `dev` (`cache: false, persistent: true`); remote cache выключен.
- [x] Создать заготовки `packages/shared`, `packages/server`, `packages/client`, `packages/e2e` с `package.json`, именами `@bad-crm/<name>` и скриптами, совпадающими с задачами turbo.
- [x] Добавить `.nvmrc` со значением `22`. *Отклонение: `.nvmrc` содержит полную версию `22.22.1` — она обязана совпадать с floor из `engines.node`, что и проверяет `test/repo/toolchain-versions.test.ts`.*
- [x] Настроить ESLint-правило `import/no-restricted-paths` для направления зависимостей (`shared` ← `server`/`client`, `e2e` изолирован) — правило описано в STORY-001-03, здесь фиксируется контракт границ. *Отклонение по механизму: направление пакетов закрыто `no-restricted-imports` по группам `@bad-crm/*` (`SHARED_IS_LEAF`, `SERVER_STAYS_SERVER`, `CLIENT_STAYS_CLIENT`, `E2E_IS_BLACK_BOX` в `eslint.config.js`), а не `import/no-restricted-paths`: пакеты видят друг друга по имени воркспейса, а не по относительному пути, и path-правило их импорты просто не заметило бы. Контракт тот же и покрыт фикстурами.*
- [x] Прогнать `pnpm build` дважды и зафиксировать в `docs/brain/` замер холодного и кешированного прогона. *Замер от 2026-07-27 (Apple M4, 16 GB): холодный `turbo run build --force` — 1,4 с; повторный `pnpm build` — `8ms >>> FULL TURBO`. Зафиксирован в `docs/brain/2026-07-27--epic-001-service-checks-and-preflight.md` и в `docs/runbooks/local-environment.md` §6.*

## Definition of Done

- [x] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [x] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [x] Документация обновлена (docs/ + запись в `docs/brain/`)
- [x] a11y-проверка (для UI-историй) — не применимо
- [x] i18n: строки в обоих языках, хардкода нет (для UI-историй) — не применимо

## Ссылки

- Документация: [`stack.md` → Раскладка монорепо](../../../docs/architecture/stack.md), [ADR-0001](../../../docs/architecture/adr/0001-monorepo-pnpm-turborepo.md)
- Правила: `rules/naming-and-structure.mdc`, `rules/dependencies.mdc`
