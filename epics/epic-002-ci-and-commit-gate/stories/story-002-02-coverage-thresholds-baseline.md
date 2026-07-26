---
id: STORY-002-02
epic: EPIC-002
status: backlog
blocked: false
priority: must
estimate: S
---

# STORY-002-02 — Пороги покрытия и baseline против регресса

**Как** разработчик Bad CRM **я хочу** автоматическую проверку покрытия по областям кода и защиту
от его снижения **чтобы** обещание «100 % изменённых строк и ≥ 85 % ветвей» было фактом сборки, а
не намерением.

## Acceptance (Given/When/Then)

- **Given** порог `domain/**/access/*.policy.ts` = 100 % строк и ветвей **When** в policy добавлена непокрытая ветка **Then** `pnpm test` и CI падают с указанием файла и непокрытых строк.
- **Given** пороги по областям (`domain` 95/90, `application` 90/85, `infrastructure`/`presentation` 75/70, весь `packages/server` 85/80) **When** покрытие любой области ниже порога **Then** сборка красная.
- **Given** зафиксированный baseline покрытия в `coverage-baseline.json` **When** PR снижает общее покрытие более чем на допуск (0.5 п.п.) **Then** сборка красная с diff-отчётом «было / стало», даже если абсолютные пороги ещё соблюдены.
- **Given** PR, добавляющий новый файл без единого теста **When** CI считает покрытие изменённых строк **Then** проверка падает: изменённые строки покрыты не полностью.
- **Given** тест-пустышка (`expect(true).toBe(true)`) как единственный тест на новый код **When** запускается агент `test-coverage` в гейте **Then** он возвращает FAIL с указанием, что тест не проверяет поведение.
- **Given** осознанно исключённый из покрытия файл (сгенерированный код, `*.gen.ts`) **When** смотрю конфигурацию **Then** исключение перечислено явным списком с комментарием-обоснованием, wildcard-исключений целых каталогов `src/**` нет.
- **Given** зелёный прогон **When** CI завершается **Then** сводка покрытия публикуется в job summary и комментарием к PR.

## Задачи

- [ ] Написать тест на конфигурацию: `test/ci/coverage-config.test.ts` — проверяет, что пороги в `vitest.config.ts` совпадают с таблицей из [`stack.md`](../../../docs/architecture/stack.md) и что список `coverage.exclude` не содержит широких масок.
- [ ] Настроить `vitest` coverage (`provider: v8`) с `thresholds` по glob-областям в `packages/server/vitest.config.ts` и `packages/client/vitest.config.ts`.
- [ ] Реализовать `scripts/coverage-baseline.ts`: чтение `coverage-summary.json`, сравнение с `coverage-baseline.json`, ненулевой код при регрессе больше допуска; команда `--update` для осознанного обновления baseline.
- [ ] Реализовать проверку покрытия изменённых строк: сопоставление `git diff` PR с `lcov`-отчётом; непокрытая изменённая строка → провал с перечнем `file:line`.
- [ ] Добавить в `.github/workflows/ci.yml` шаг публикации сводки покрытия и комментария к PR.
- [ ] Зафиксировать в `docs/runbooks/ci.md` процедуру осознанного обновления baseline (кто и когда вправе его двигать).

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y-проверка (для UI-историй) — не применимо
- [ ] i18n: строки в обоих языках, хардкода нет (для UI-историй) — не применимо

## Ссылки

- Документация: [`stack.md` → Пороги покрытия](../../../docs/architecture/stack.md), [`prd.md` → success-метрики, NFR-10](../../../docs/product/prd.md)
- Правила: `rules/tdd-and-commit-gate.mdc`, `rules/testing.mdc`
