---
id: STORY-001-03
epic: EPIC-001
status: review
blocked: false
priority: must
estimate: M
---

# STORY-001-03 — ESLint 9 flat, Prettier, husky, lint-staged, commitlint

**Как** разработчик Bad CRM **я хочу** единые правила стиля и архитектурные запреты, проверяемые
автоматически до коммита **чтобы** ревью обсуждало смысл изменения, а не форматирование, и чтобы
запрещённые импорты не просачивались в код месяцами.

## Acceptance (Given/When/Then)

- **Given** flat config `eslint.config.js` в корне **When** выполняю `pnpm lint` **Then** проверяются все четыре пакета с общими базовыми правилами и пакетными оверрайдами; предупреждений не остаётся (`--max-warnings 0`).
- **Given** файл `packages/server/src/presentation/http/controllers/health.controller.ts` с вызовом `prisma.user.findMany()` **When** запускаю `pnpm lint` **Then** линт падает: прямой доступ к Prisma разрешён только внутри `src/infrastructure/persistence/**`.
- **Given** файл `packages/client/src/units/auth/service/hooks/use-login.hook.ts` с вызовом `fetch('/api/v1/auth/login')` **When** запускаю `pnpm lint` **Then** линт падает: raw `fetch`/`axios` запрещены вне `src/shared/api`.
- **Given** файл в `packages/server/src/domain/**` с `import { PrismaClient } from '@prisma/client'` **When** запускаю `pnpm lint` **Then** линт падает: домен не знает об инфраструктуре.
- **Given** staged-файл с нарушением Prettier **When** делаю `git commit` **Then** lint-staged форматирует его автоматически, и в коммит попадает отформатированная версия.
- **Given** сообщение коммита `added login` **When** делаю `git commit` **Then** commitlint отклоняет коммит с подсказкой о Conventional Commits; сообщение `feat(auth): add login endpoint` принимается.
- **Given** staged-файл с `console.log` или `debugger` **When** делаю `git commit` **Then** коммит блокируется правилом чистоты (`no-console` для `src/**`, `no-debugger`).

## Задачи

- [ ] Написать тесты на архитектурные запреты: `test/lint/architecture-rules.test.ts` — прогоняет ESLint программно на фикстурах (контроллер с `prisma.`, домен с `@prisma/client`, клиентский хук с `fetch`) и ожидает конкретные ошибки.
- [ ] Создать `eslint.config.js` (flat): базовый набор `@eslint/js` + `typescript-eslint` (typed rules), `eslint-plugin-import` (`import/no-restricted-paths`, `import/order`), `eslint-plugin-unicorn` (выборочно), для клиента — `eslint-plugin-react`, `react-hooks`, `jsx-a11y`.
- [ ] Добавить `no-restricted-imports` (домен ↔ инфраструктура, `@prisma/client` вне persistence) и `no-restricted-syntax` (`prisma.` вне persistence, `fetch(`/`axios` вне `shared/api`).
- [ ] Добавить `import/no-restricted-paths` для FSD-направления слоёв клиента и для границ пакетов монорепо.
- [ ] Создать `.prettierrc` (`printWidth: 100`, `singleQuote: true`, `trailingComma: all`, `semi: true`) и `.prettierignore`; включить `eslint-config-prettier` последним в цепочке.
- [ ] Настроить husky: `pre-commit` → `lint-staged`, `commit-msg` → `commitlint`; `.lintstagedrc` — `eslint --fix` + `prettier --write` для `*.{ts,tsx}`, `prettier --write` для `*.{json,md,yaml,css}`.
- [ ] Создать `commitlint.config.js` на `@commitlint/config-conventional` с ограничением `subject-max-length: 50` и списком scope-ов (пакеты + домены).
- [ ] Добавить `pnpm format` и `pnpm format:check` в корневые скрипты.

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y-проверка (для UI-историй) — не применимо
- [ ] i18n: строки в обоих языках, хардкода нет (для UI-историй) — не применимо

## Ссылки

- Документация: [`stack.md` → Команды](../../../docs/architecture/stack.md), [`rls-design.md` → ESLint: нет прямых `prisma.*`](../../../docs/security/rls-design.md), [`overview.md` → Проверяемые следствия правил](../../../docs/architecture/overview.md)
- Правила: `rules/naming-and-structure.mdc`, `rules/commit-hygiene.mdc`, `rules/tdd-and-commit-gate.mdc`
