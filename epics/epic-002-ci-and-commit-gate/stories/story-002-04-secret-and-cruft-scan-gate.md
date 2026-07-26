---
id: STORY-002-04
epic: EPIC-002
status: backlog
blocked: false
priority: must
estimate: S
---

# STORY-002-04 — Блокирующий скан секретов и мусора

**Как** администратор системы **я хочу** чтобы попавший в коммит ключ или отладочный код физически
не проходили в основную ветку **чтобы** не приходилось экстренно ротировать секреты и вычищать
`debugger` из продакшена.

## Acceptance (Given/When/Then)

- **Given** PR, добавляющий строку вида `AWS_SECRET_ACCESS_KEY=AKIA...` или приватный ключ в любом файле **When** запускается шаг gitleaks **Then** сборка падает, в отчёте — файл, строка и тип находки, само значение маскировано.
- **Given** PR с `debugger`, `describe.only`, `it.only` или маркером конфликта `<<<<<<<` **When** запускается `scan-cruft --staged` в CI-режиме **Then** сборка падает (BLOCK-уровень).
- **Given** PR с `console.log` в `src/**` или `TODO` **When** запускается скан **Then** выдаётся WARN в job summary, сборка не падает, но замечание видно ревьюеру.
- **Given** файл-фикстура тестов с заведомо «секретоподобной» строкой **When** он перечислен в `.gitleaksignore` с комментарием и датой **Then** скан не срабатывает; неаннотированное исключение отвергается ревью.
- **Given** история репозитория **When** запускается плановый полный скан (по расписанию, не на каждом PR) **Then** проверяется весь `git log`, а не только дифф, и находка заводит issue.
- **Given** обнаруженный секрет **When** сборка упала **Then** в job summary есть ссылка на процедуру ротации из `docs/runbooks/`, а значение секрета в логи CI не попадает.

## Задачи

- [ ] Написать тесты на скан: `test/ci/scan.test.ts` — прогоняет сканер на фикстурах (`fixtures/leaked-key.txt`, `fixtures/with-debugger.ts`, `fixtures/todo-only.ts`) и проверяет коды возврата BLOCK / WARN / OK.
- [ ] Добавить шаг `gitleaks` в `.github/workflows/ci.yml` с конфигурацией `.gitleaks.toml` (правила + allow-list с обоснованиями).
- [ ] Добавить шаг запуска `scan-cruft` в режиме диффа PR; BLOCK-уровень → `exit 1`, WARN → аннотация в summary.
- [ ] Создать `.gitleaksignore` с обязательным форматом строки (путь, причина, дата, автор решения) и тестом на формат.
- [ ] Добавить workflow по расписанию `secrets-scan-full.yml` — полный скан истории раз в неделю, создание issue при находке.
- [ ] Настроить маскирование потенциальных значений в логах CI (`::add-mask::`).
- [ ] Описать в `docs/runbooks/secret-rotation.md` порядок действий при находке: что ротировать, в каком порядке, как подтвердить.

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y-проверка (для UI-историй) — не применимо
- [ ] i18n: строки в обоих языках, хардкода нет (для UI-историй) — не применимо

## Ссылки

- Документация: [`prd.md` → NFR-6](../../../docs/product/prd.md), [`stack.md` → Редактирование секретов в логах](../../../docs/architecture/stack.md), [`threat-model.md`](../../../docs/security/threat-model.md)
- Правила: `rules/security.mdc`, `rules/commit-hygiene.mdc`
