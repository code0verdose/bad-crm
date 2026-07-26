---
id: STORY-002-05
epic: EPIC-002
status: backlog
blocked: false
priority: should
estimate: S
---

# STORY-002-05 — CodeQL, dependency-review и проверка лицензий

**Как** владелец инсталляции **я хочу** чтобы уязвимые и юридически несовместимые зависимости не
попадали в продукт **чтобы** распространение под AGPL-3.0 оставалось законным, а известные CVE не
доезжали до self-host-инсталляций.

## Acceptance (Given/When/Then)

- **Given** PR, добавляющий пакет под лицензией `BSL-1.1`, `SSPL-1.0`, `Elastic-2.0`, `GPL-2.0-only` или проприетарной **When** запускается проверка лицензий **Then** сборка падает с именем пакета, версией, лицензией и ссылкой на таблицу разрешённых лицензий.
- **Given** PR, добавляющий пакет с лицензией `MIT`/`Apache-2.0`/`MPL-2.0` **When** проверка выполняется **Then** она проходит без вмешательства.
- **Given** транзитивная зависимость с неизвестной или отсутствующей лицензией **When** проверка выполняется **Then** сборка падает: «неизвестно» трактуется как «запрещено» до ручного решения, зафиксированного в ADR.
- **Given** PR, поднимающий версию пакета с известной уязвимостью High/Critical **When** отрабатывает `dependency-review-action` **Then** мерж блокируется с указанием CVE и безопасной версии.
- **Given** изменение в TypeScript-коде **When** отрабатывает CodeQL **Then** алерты уровня error появляются в Security-вкладке и блокируют мерж; low/note — не блокируют.
- **Given** пакет с `postinstall`-скриптом, отсутствующий в `pnpm.onlyBuiltDependencies` **When** выполняется установка **Then** скрипт не запускается, и это видно в логе (защита от supply-chain).
- **Given** осознанно разрешённая LGPL/GPL-3.0-зависимость **When** смотрю allow-list **Then** запись сопровождается ссылкой на ADR, где зафиксировано решение.

## Задачи

- [ ] Написать тест `test/ci/licenses.test.ts`: прогоняет проверку лицензий на фикстурном дереве зависимостей и ожидает провал для запрещённых лицензий и успех для разрешённых.
- [ ] Реализовать `scripts/check-licenses.ts` поверх `license-checker`/`pnpm licenses list --json`: allow-list из [`stack.md`](../../../docs/architecture/stack.md), отчёт в job summary, ненулевой код при находке.
- [ ] Добавить шаг проверки лицензий в `ci.yml` и запуск на Dependabot-PR.
- [ ] Создать `.github/workflows/codeql.yml` для языка `javascript-typescript` с запуском на PR и по расписанию.
- [ ] Добавить `dependency-review-action` на pull request с `fail-on-severity: high` и собственным списком запрещённых лицензий (второй, независимый рубеж).
- [ ] Добавить шаг `pnpm audit --audit-level=high` и/или `osv-scanner`; результат — блокирующий для High/Critical.
- [ ] Зафиксировать `pnpm.onlyBuiltDependencies` allow-list в корневом `package.json` и тест на то, что список не пуст и не содержит «`*`».
- [ ] Описать процедуру исключения в `docs/architecture/adr/`: шаблон записи «пакет, лицензия, почему допустимо, кто решил».

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y-проверка (для UI-историй) — не применимо
- [ ] i18n: строки в обоих языках, хардкода нет (для UI-историй) — не применимо

## Ссылки

- Документация: [`stack.md` → Политика зависимостей](../../../docs/architecture/stack.md), [`prd.md` → NFR-11, риск R-13](../../../docs/product/prd.md), [ADR-0018](../../../docs/architecture/adr/0018-license-agpl-3.md)
- Правила: `rules/dependencies.mdc`, `rules/security.mdc`
