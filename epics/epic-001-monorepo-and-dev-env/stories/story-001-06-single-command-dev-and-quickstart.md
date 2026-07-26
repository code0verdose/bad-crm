---
id: STORY-001-06
epic: EPIC-001
status: backlog
blocked: false
priority: must
estimate: S
---

# STORY-001-06 — pnpm dev одной командой и quickstart

**Как** разработчик Bad CRM **я хочу** запускать весь стек одной командой и иметь пошаговый
quickstart **чтобы** время от `git clone` до работающего приложения измерялось минутами, а не
часом чтения конфигов.

## Acceptance (Given/When/Then)

- **Given** чистый клон, установленный Docker и Node 22 **When** выполняю по шагам quickstart из `README.md` (`pnpm install` → `cp .env.example .env` → `pnpm docker:up` → `pnpm dev`) **Then** клиент доступен на `http://localhost:5173`, сервер отвечает `200` на `GET /health`, суммарное время до готовности — менее 10 минут на чистом хосте.
- **Given** запущенный `pnpm dev` **When** правлю файл в `packages/server/src` **Then** сервер перезапускается через `tsx watch` без ручного рестарта; правка в `packages/client/src` применяется через HMR без потери состояния маршрута.
- **Given** запущенный `pnpm dev` **When** правлю файл в `packages/shared/src` **Then** и сервер, и клиент подхватывают изменение (watch-сборка `shared` включена в pipeline).
- **Given** не поднятый docker-стек **When** выполняю `pnpm dev` **Then** команда завершается с понятной подсказкой «сначала `pnpm docker:up`», а не с сырым `ECONNREFUSED`.
- **Given** Node версии 20 **When** выполняю `pnpm install` **Then** установка отклоняется по `engines` с указанием требуемой версии.
- **Given** нажатие `Ctrl+C` в `pnpm dev` **When** процессы завершаются **Then** дочерние процессы сервера и клиента останавливаются, «осиротевших» слушателей портов не остаётся.

## Задачи

- [ ] Написать тест `test/env/preflight.test.ts` на скрипт предстартовой проверки: недоступный Postgres → ненулевой код возврата и текст с подсказкой; всё доступно → код 0.
- [ ] Реализовать `scripts/preflight.ts`: проверка версии Node, наличия `.env`, доступности Postgres/Redis/MinIO; понятные сообщения на русском и английском (пока текст один — англ., i18n сообщений CLI вне скоупа).
- [ ] Настроить корневой скрипт `dev`: `turbo run dev --parallel` с задачами `dev` в `shared` (tsc watch), `server` (`tsx watch src/main.ts`), `client` (`vite`); `predev` → `preflight`.
- [ ] Настроить корректную обработку сигналов, чтобы `Ctrl+C` завершал всё дерево процессов.
- [ ] Написать `README.md`: назначение проекта, требования (Node 22, pnpm 9, Docker 24), quickstart из четырёх команд, таблица портов сервисов, ссылки на `docs/` и `epics/`, лицензия AGPL-3.0.
- [ ] Провести протокол замера времени холодного старта на чистой VM и зафиксировать медиану в `docs/runbooks/local-environment.md` (контрольная точка NFR-3).

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y-проверка (для UI-историй) — не применимо
- [ ] i18n: строки в обоих языках, хардкода нет (для UI-историй) — не применимо

## Ссылки

- Документация: [`stack.md` → Команды](../../../docs/architecture/stack.md), [`prd.md` → NFR-3, риск R-14](../../../docs/product/prd.md), [`roadmap.md` → M1 критерий выхода](../../../docs/product/roadmap.md)
- Правила: `rules/naming-and-structure.mdc`
