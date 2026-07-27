---
id: STORY-002-02
epic: EPIC-002
status: in-progress
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

- [x] Написать тест на конфигурацию: `test/ci/coverage-config.test.ts` — проверяет, что пороги в `vitest.config.ts` совпадают с таблицей из [`stack.md`](../../../docs/architecture/stack.md) и что список `coverage.exclude` не содержит широких масок.
  — выполнено раньше и под другим именем: `test/repo/coverage-contract.test.ts` сверяет пороги всех четырёх конфигов с таблицей §7, требует явного `include: [src/**]` и запрещает `thresholds.autoUpdate`.
- [x] Настроить `vitest` coverage (`provider: v8`) с `thresholds` по glob-областям в `packages/server/vitest.config.ts` и `packages/client/vitest.config.ts`.
  — выполнено раньше (EPIC-001): пороги по областям стоят в `packages/{server,client,shared}/vitest.config.ts` и в корневом `vitest.config.ts`.
- [x] Реализовать `scripts/coverage-baseline.ts`: чтение `coverage-summary.json`, сравнение с `coverage-baseline.json`, ненулевой код при регрессе больше допуска; команда `--update` для осознанного обновления baseline.
  — реализовано как `scripts/ci/coverage-baseline.ts` (чистая логика — `coverage-baseline.util.ts`, 17 тестов, TDD): `pnpm coverage:baseline [--update]`, допуск 0.5 п.п., числа в `coverage-baseline.json`. Отсутствующий отчёт трактуется как провал, а не как «нечего сравнивать» — иначе гейт молча выключается ровно тогда, когда тесты не прогнались.
- [ ] Реализовать проверку покрытия изменённых строк: сопоставление `git diff` PR с `lcov`-отчётом; непокрытая изменённая строка → провал с перечнем `file:line`.
  — не сделано: сравнение `git diff` с `lcov` остаётся открытым. Сегодня регресс ловится порогами областей плюс baseline; строчная проверка изменённых строк — отдельная задача.
- [x] Добавить в `.github/workflows/ci.yml` шаг публикации сводки покрытия и комментария к PR.
  — сводка идёт в job summary, отчёты покрытия выгружаются артефактом при любом исходе (`if: always()`). **Комментария к PR намеренно нет:** он требует `pull-requests: write`, а токен события `pull_request` из форка — read-only, то есть проверка молча пропала бы именно на внешних контрибуциях. Baseline-файл работает и для форков, и его правка видна в диффе.
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
