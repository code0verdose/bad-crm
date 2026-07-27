---
id: STORY-002-06
epic: EPIC-002
status: in-progress
blocked: false
priority: should
estimate: S
---

# STORY-002-06 — Шаблоны PR/issue, Dependabot, проверка коммитов

**Как** разработчик Bad CRM **я хочу** единый формат pull request, issue и коммитов плюс
автоматические обновления зависимостей **чтобы** история репозитория читалась, а обновления не
копились до состояния «страшно трогать».

## Acceptance (Given/When/Then)

- **Given** открытие pull request **When** появляется форма **Then** она предзаполнена шаблоном: что и зачем, ссылка на историю (`STORY-NNN-XX`), чек-лист DoD (тесты, гейт, документация, i18n, a11y), раздел «риски и откат».
- **Given** PR с заголовком `fix login` **When** отрабатывает проверка Conventional Commits **Then** она падает; заголовок `fix(auth): reject expired refresh token` проходит.
- **Given** ветка с коммитами, часть из которых не соответствует формату **When** отрабатывает проверка **Then** перечислены конкретные коммиты и требуемый формат.
- **Given** новая issue **When** выбираю тип **Then** доступны шаблоны «Баг» (шаги воспроизведения, ожидаемое/фактическое, версия, окружение) и «Задача/предложение» (проблема, предложение, влияние на скоуп и Won't-список).
- **Given** понедельник **When** отрабатывает Dependabot **Then** создаются сгруппированные PR: `dev`, `prod-patch`, `prod-minor`; мажорные обновления — отдельными PR; для `github-actions` и `docker` — свои расписания.
- **Given** Dependabot-PR **When** он открыт **Then** он проходит полный CI, включая лицензии и аудит, и **не** мержится автоматически.
- **Given** PR без ссылки на историю **When** ревьюер открывает его **Then** незаполненный чек-лист виден, а проверка «в описании есть `STORY-` или явное `no-story:` с причиной» падает.

## Задачи

- [ ] Написать тест `test/ci/templates.test.ts`: проверяет наличие и структуру `.github/pull_request_template.md`, `.github/ISSUE_TEMPLATE/*.yml`, `.github/dependabot.yml` (наличие групп и расписаний).
- [x] Создать `.github/pull_request_template.md` по описанной структуре.
- [x] Создать `.github/ISSUE_TEMPLATE/bug_report.yml` и `feature_request.yml` (форматы форм GitHub), а также `config.yml` с ссылкой на документацию.
- [x] Создать `.github/dependabot.yml`: экосистемы `npm` (еженедельно, группы `dev`/`prod-patch`/`prod-minor`), `github-actions`, `docker-compose`; лимит открытых PR.
- [x] Добавить в CI job `commit-lint`: проверка заголовка PR и всех коммитов ветки через `commitlint --from origin/main` (реализовано как `.github/workflows/pr-conventions.yml`, диапазон `base.sha..head.sha`).
- [x] Добавить проверку «PR ссылается на историю» с возможностью явного исключения `no-story:` и обоснованием.
- [x] Описать порядок: ветка → коммиты → PR → гейт → мерж, включая политику атрибуции коммитов — в `CONTRIBUTING.md` §11 «From branch to merge» (и в русской секции), а не отдельным файлом: дублировать существующий CONTRIBUTING.md нечем.

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y-проверка (для UI-историй) — не применимо
- [ ] i18n: строки в обоих языках, хардкода нет (для UI-историй) — не применимо

## Ссылки

- Документация: [`stack.md` → Политика зависимостей](../../../docs/architecture/stack.md), [`project-management`](../../../docs/README.md)
- Правила: `rules/commit-hygiene.mdc`, `rules/dependencies.mdc`
