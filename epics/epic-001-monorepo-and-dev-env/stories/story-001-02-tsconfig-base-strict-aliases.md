---
id: STORY-001-02
epic: EPIC-001
status: review
blocked: false
priority: must
estimate: S
---

# STORY-001-02 — tsconfig.base.json strict и path-алиасы

**Как** разработчик Bad CRM **я хочу** единую строгую конфигурацию TypeScript и алиасы путей во всех
пакетах **чтобы** ошибки типов ловились компилятором, а импорты не превращались в `../../../`.

## Acceptance (Given/When/Then)

- **Given** `tsconfig.base.json` с `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax` **When** в любом пакете пишу `const x = arr[0]; x.toUpperCase()` **Then** `pnpm typecheck` падает: элемент может быть `undefined`.
- **Given** серверный пакет с `module: NodeNext` и алиасом `@/*` → `src/*` **When** импортирую `@/application/health/use-cases/check-health.use-case`, собираю `pnpm --filter @bad-crm/server build` и запускаю `node dist/main.js` **Then** приложение стартует: `tsc-alias` развернул алиас в относительный путь.
- **Given** `packages/shared/tsconfig.json` с `lib: ["ES2023"]` без `DOM` и без `@types/node` **When** в `shared` появляется `window.localStorage` или `import fs from 'node:fs'` **Then** `pnpm typecheck` падает.
- **Given** клиентский пакет **When** импортирую `@shared/lib/validation` и `@units/auth` **Then** и `tsc --noEmit`, и `vite build` резолвят пути (алиасы объявлены и в `tsconfig`, и в `vite.config.ts` — значения совпадают).
- **Given** алиас, объявленный только в `tsconfig`, но забытый в `vite.config.ts` **When** запускаю тест `client/test/config/aliases.test.ts` **Then** тест падает со списком расхождений.
- **Given** сгенерированный `.d.ts` пакета `shared` **When** его импортирует `server` **Then** типы разрешаются без `skipLibCheck`-обхода для собственного кода.

## Задачи

- [ ] Написать тест `packages/client/test/config/aliases.test.ts`: читает `tsconfig.json` (`compilerOptions.paths`) и `vite.config.ts` (`resolve.alias`), сравнивает множества ключей и целей; расхождение = провал.
- [ ] Написать тест `packages/shared/test/config/isomorphic.test.ts`: сканирует `src/**` на импорты `node:*`, `fs`, `path`, обращения к `window`/`document`; находка = провал.
- [ ] Создать `tsconfig.base.json`: `target: ES2023`, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`, `isolatedModules`, `skipLibCheck` только для `node_modules`.
- [ ] Создать `packages/shared/tsconfig.json` (`lib: ["ES2023"]`, без `types`), `packages/server/tsconfig.json` (`module/moduleResolution: NodeNext`, `paths: { "@/*": ["src/*"] }`, `tsc-alias` в build-скрипте), `packages/client/tsconfig.json` (`module: ESNext`, `moduleResolution: Bundler`, `jsx: react-jsx`, алиасы `@app/*`, `@pages`, `@widgets/*`, `@units/*`, `@shared`, `@shared/*`, `@/*`).
- [ ] Продублировать клиентские алиасы в `packages/client/vite.config.ts` (`resolve.alias`) и в `vitest` config.
- [ ] Добавить `packages/e2e/tsconfig.json` без ссылок на исходники приложения.
- [ ] Добавить корневой скрипт `pnpm typecheck` → `turbo run typecheck` и убедиться, что он покрывает все четыре пакета.

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y-проверка (для UI-историй) — не применимо
- [ ] i18n: строки в обоих языках, хардкода нет (для UI-историй) — не применимо

## Ссылки

- Документация: [`stack.md` → Алиасы и модульная система](../../../docs/architecture/stack.md), [`ux-architecture.md`](../../../docs/architecture/ux-architecture.md)
- Правила: `rules/naming-and-structure.mdc`, `rules/frontend-fsd.mdc`
