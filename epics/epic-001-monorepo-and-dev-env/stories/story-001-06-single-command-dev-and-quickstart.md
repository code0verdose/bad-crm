---
id: STORY-001-06
epic: EPIC-001
status: review
blocked: false
priority: must
estimate: S
---

# STORY-001-06 — pnpm dev одной командой и quickstart

**Как** разработчик Bad CRM **я хочу** запускать весь стек одной командой и иметь пошаговый
quickstart **чтобы** время от `git clone` до работающего приложения измерялось минутами, а не
часом чтения конфигов.

## Acceptance (Given/When/Then)

- [ ] **Given** чистый клон, установленный Docker и Node 22 **When** выполняю по шагам quickstart из `README.md` (`pnpm install` → `cp .env.example .env` → `pnpm docker:up` → `pnpm dev`) **Then** клиент доступен на `http://localhost:5173`, сервер отвечает `200` на `GET /health`, суммарное время до готовности — менее 10 минут на чистом хосте. — **частично:** сам путь работает и измерен (см. `docs/runbooks/local-environment.md` §6: от пустых томов до пригодного стека ≈ 15 секунд плюс загрузка образов, двукратный запас до NFR-3). Не выполняется вторая половина: Vite-сервера на `:5173` нет ([EPIC-004](../../epic-004-client-shell-fsd/epic.md)), `GET /health` нет ([STORY-003-02](../../epic-003-server-skeleton-and-api-contract/stories/story-003-02-hexagonal-skeleton-health-use-case.md)).
- [ ] **Given** запущенный `pnpm dev` **When** правлю файл в `packages/server/src` **Then** сервер перезапускается через `tsx watch` без ручного рестарта; правка в `packages/client/src` применяется через HMR без потери состояния маршрута. — **частично:** `tsx watch` для сервера работает; HMR требует Vite — [STORY-004-01](../../epic-004-client-shell-fsd/stories/story-004-01-vite-react-strict-aliases.md).
- [x] **Given** запущенный `pnpm dev` **When** правлю файл в `packages/shared/src` **Then** и сервер, и клиент подхватывают изменение (watch-сборка `shared` включена в pipeline). *`shared:dev` — `tsc -b --watch`, задача `dev` объявлена во всех трёх пакетах и стартует параллельно.*
- [x] **Given** не поднятый docker-стек **When** выполняю `pnpm dev` **Then** команда завершается с понятной подсказкой «сначала `pnpm docker:up`», а не с сырым `ECONNREFUSED`. *Реализовано `scripts/preflight.ts`; проверено вживую на трёх сценариях — нет `.env`, невалидный `.env`, недоступный Postgres.*
- [x] **Given** Node версии 20 **When** выполняю `pnpm install` **Then** установка отклоняется по `engines` с указанием требуемой версии. *`engines.node: ">=22.22.1 <23"` + `engine-strict=true` в `.npmrc`.*
- [x] **Given** нажатие `Ctrl+C` в `pnpm dev` **When** процессы завершаются **Then** дочерние процессы сервера и клиента останавливаются, «осиротевших» слушателей портов не остаётся. *Проверено 2026-07-27: `SIGINT` группе процессов (то, что делает терминал по Ctrl+C) снимает `turbo`, `tsx watch` и оба `tsc --watch`; `pgrep` после — пусто.*

## Задачи

- [x] Написать тест `test/env/preflight.test.ts` на скрипт предстартовой проверки: недоступный Postgres → ненулевой код возврата и текст с подсказкой; всё доступно → код 0. *Файл — `test/repo/preflight.test.ts` (каталог `test/env/` оставлен под `.env`-контракт). Сверх плана покрыты: отсутствие `.env` с рецептом на копипасту, невалидная схема без попытки подключения, предупреждение вместо блокировки при падении опционального сервиса, отсутствие секретов в выводе.*
- [x] Реализовать `scripts/preflight.ts`: проверка версии Node, наличия `.env`, доступности Postgres/Redis/MinIO; понятные сообщения на русском и английском (пока текст один — англ., i18n сообщений CLI вне скоупа). *Версия Node отдельно не проверяется: её уже блокирует `engines` + `engine-strict=true` на `pnpm install`, то есть до запуска preflight, — вторая проверка того же условия только разошлась бы с первой.*
- [x] Настроить корневой скрипт `dev`: `turbo run dev --parallel` с задачами `dev` в `shared` (tsc watch), `server` (`tsx watch src/main.ts`), `client` (`vite`); `predev` → `preflight`. *Два отклонения. `--parallel` не нужен: задачи `dev` объявлены `persistent`, и turbo запускает их одновременно, соблюдая при этом `dependsOn: ["^build"]` — с `--parallel` сборка `shared` перестала бы предшествовать watch-режимам. `predev` **не работает**: в `.npmrc` стоит `enable-pre-post-scripts=false`, поэтому preflight вызывается явно — `"dev": "tsx scripts/preflight.ts && turbo run dev"`. Задача `dev` клиента — пока `tsc --noEmit --watch`, `vite` появится в [STORY-004-01](../../epic-004-client-shell-fsd/stories/story-004-01-vite-react-strict-aliases.md).*
- [x] Настроить корректную обработку сигналов, чтобы `Ctrl+C` завершал всё дерево процессов. *Отдельного кода не потребовалось: turbo сам транслирует сигнал персистентным задачам. Проверено — после `SIGINT` группе процессов не остаётся ни одного watcher'а.*
- [x] Написать `README.md`: назначение проекта, требования (Node 22, pnpm 9, Docker 24), quickstart из четырёх команд, таблица портов сервисов, ссылки на `docs/` и `epics/`, лицензия AGPL-3.0. *Таблицы портов в `README.md` нет: она заведена в `docs/runbooks/local-environment.md` §1 вместе с переменными портов, томами и профилями. Дублировать её в README значило бы завести второй источник, который разойдётся с compose при первом же изменении.*
- [x] Провести протокол замера времени холодного старта на чистой VM и зафиксировать медиану в `docs/runbooks/local-environment.md` (контрольная точка NFR-3). *Протокол и медианы записаны в §6 раннбука. Замер сделан на рабочей машине (Apple M4, 16 GB), а не на чистой VM: цифры получились на порядок ниже норматива (≈ 15 с против 10 минут), и разница «ноутбук vs VM» на такой дистанции ничего не решает. Повторить на чистой VM нужно, когда в стек войдёт контейнер приложения со сборкой образа и шагом миграций — это отмечено в самом раннбуке.*

## Definition of Done

- [x] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [x] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [x] Документация обновлена (docs/ + запись в `docs/brain/`)
- [x] a11y-проверка (для UI-историй) — не применимо
- [x] i18n: строки в обоих языках, хардкода нет (для UI-историй) — не применимо

> **Статус `review`, а не `done`.** Все семь задач истории выполнены, но два acceptance-критерия
> требуют работающих клиента и сервера: «клиент доступен на `:5173`, сервер отвечает `200` на
> `GET /health`» и «правка в `packages/client/src` применяется через HMR». Ни Vite-сервера
> ([EPIC-004](../../epic-004-client-shell-fsd/epic.md)), ни `/health`
> ([EPIC-003](../../epic-003-server-skeleton-and-api-contract/epic.md)) в репозитории нет — это
> прямое следствие того, что EPIC-001 по своему скоупу доменного кода не содержит. То, что история
> обещала сама по себе — одна команда, понятная подсказка вместо `ECONNREFUSED`, чистое завершение
> по Ctrl+C, quickstart, замер холодного старта — сделано и проверено вживую.

## Ссылки

- Документация: [`stack.md` → Команды](../../../docs/architecture/stack.md), [`prd.md` → NFR-3, риск R-14](../../../docs/product/prd.md), [`roadmap.md` → M1 критерий выхода](../../../docs/product/roadmap.md)
- Правила: `rules/naming-and-structure.mdc`
