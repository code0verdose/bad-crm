---
id: EPIC-001
title: Монорепо и dev-окружение
status: review
blocked: false
milestone: M1
owner: unassigned
created: 2026-07-26
---

# EPIC-001 — Монорепо и dev-окружение

## Зачем (ценность)

Bad CRM состоит из клиента, сервера, общего изоморфного кода и e2e-набора, которые обязаны делить
типы, Zod-схемы и коды ошибок без публикации пакетов в реестр. Без монорепо с единым pipeline
каждый пакет начинает жить своей жизнью: расходятся версии TypeScript, дублируются валидаторы,
локальный запуск требует шести ручных шагов. Эпик даёт скелет репозитория, единые конфиги и
`docker compose`-окружение, после которых любой контрибьютор поднимает проект одной командой и
получает то же поведение, что и CI.

## Scope

### В скоупе

- `pnpm-workspace.yaml` с пакетами `shared`, `server`, `client`, `e2e` и корневые скрипты-обёртки над turborepo.
- `turbo.json` с задачами `build`, `typecheck`, `lint`, `test`, `test:e2e`, `dev`, `db:*` и корректным кешированием.
- `tsconfig.base.json` в strict-режиме + path-алиасы всех пакетов; отдельный tsconfig для `shared` без DOM и Node-типов.
- ESLint 9 flat config, Prettier, husky, lint-staged, commitlint (Conventional Commits).
- `docker-compose.yml`: PostgreSQL 16 + pgvector, Redis 8, MinIO, Meilisearch, Mailpit — с healthcheck и именованными томами.
- `.env.example` со всеми переменными и Zod-схема `env`, парсящаяся один раз при старте.
- `pnpm dev` — одна команда до работающего локального стека; quickstart в `README.md`.
- `packages/shared`: базовые branded-типы, Zod-примитивы, каталог кодов ошибок, заготовка каталога permissions.

### Вне скоупа

- Production-образы, multi-stage Dockerfile и self-host-поставка — [EPIC-017](../epic-017-self-host-alpha/epic.md) (M2).
- Сам CI-пайплайн и гейт коммита — [EPIC-002](../epic-002-ci-and-commit-gate/epic.md).
- Prisma-схема и миграции — [EPIC-003](../epic-003-server-skeleton-and-api-contract/epic.md).
- Роли БД `app_user` / `app_migrator` / `app_auth` — [EPIC-005](../epic-005-multi-tenancy-rls/epic.md).

## Acceptance (эпик выполнен, когда)

- [ ] `pnpm install && pnpm docker:up && pnpm dev` на чистой машине с Node 22 и Docker 24 приводит к работающим клиенту и серверу без ручных шагов сверх копирования `.env.example` → `.env`. — **не выполнено и не может быть выполнено внутри этого эпика.** Критерий требует работающих клиента и сервера, а раздел «Вне скоупа» этого же эпика отдаёт HTTP-сервер в [EPIC-003](../epic-003-server-skeleton-and-api-contract/epic.md), клиентский шелл — в [EPIC-004](../epic-004-client-shell-fsd/epic.md). Сама команда работает: `pnpm dev` прогоняет preflight и поднимает три watch-процесса; поднимать ей пока нечего. Закрывается вместе с EPIC-004.
- [x] `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm test` выполняются из корня и проходят на пустом скелете.
- [x] Turborepo кеширует повторный `pnpm build`/`pnpm typecheck`: второй прогон без изменений завершается из кеша (FULL TURBO). *Проверено 2026-07-27: `8ms >>> FULL TURBO`; правка в `shared` инвалидирует `shared`/`server`/`client` и не трогает `e2e`.*
- [x] Направление зависимостей соблюдено: `shared` не импортирует ничего из `packages/*`, `e2e` не импортирует исходники `server`/`client`; нарушение падает на линте.
- [x] Все контейнеры `docker-compose.yml` имеют healthcheck, зафиксированные версии образов и именованные тома; `pnpm docker:up` ждёт готовности сервисов.
- [ ] Старт сервера с неполным `.env` падает с внятным сообщением о конкретной переменной, а не работает «наполовину». — **частично:** схема, текст сообщения и список **всех** невалидных переменных готовы и покрыты тестами; вживую этот отказ сегодня демонстрирует preflight `pnpm dev`. Самого старта сервера нет — `main.ts` пока не вызывает `loadEnv()`. Закрывается в [STORY-003-01](../epic-003-server-skeleton-and-api-contract/stories/story-003-01-express-app-composition-root.md).
- [x] Коммит с сообщением вне Conventional Commits отклоняется локальным хуком.
- [x] `packages/shared` собирается и импортируется и из `server`, и из `client`; в нём нет Node-only и браузерных API.

## Зависимости / риски

- Зависит от: нет (стартовый эпик майлстоуна M1).
- Блокирует: [EPIC-002](../epic-002-ci-and-commit-gate/epic.md), [EPIC-003](../epic-003-server-skeleton-and-api-contract/epic.md), [EPIC-004](../epic-004-client-shell-fsd/epic.md), [EPIC-005](../epic-005-multi-tenancy-rls/epic.md), [EPIC-009](../epic-009-observability/epic.md), [EPIC-010](../epic-010-e2e-harness/epic.md).
- Риски: **R-14** (сложность самохостинга — 6 сервисов в compose): митигация — разумные дефолты, healthcheck, профиль `minimal`, quickstart, замер времени старта. **R-08** (scope creep): эпик строго ограничен скелетом, доменного кода в нём нет.

## Ссылки

- Документация: [`stack.md` → Раскладка монорепо](../../docs/architecture/stack.md), [`stack.md` → Требования к среде](../../docs/architecture/stack.md), [`stack.md` → Конфигурация и env](../../docs/architecture/stack.md), [`overview.md` → Развёртывание](../../docs/architecture/overview.md), [`prd.md` → NFR-3](../../docs/product/prd.md)
- Правила: `rules/naming-and-structure.mdc`, `rules/dependencies.mdc`, `rules/tdd-and-commit-gate.mdc`

## Истории

- [x] [STORY-001-01 — pnpm workspaces и turborepo pipeline](stories/story-001-01-pnpm-workspaces-turborepo.md) — `done`
- [ ] [STORY-001-02 — tsconfig.base.json strict и path-алиасы](stories/story-001-02-tsconfig-base-strict-aliases.md) — `review`: сторона `vite.config.ts` принадлежит [STORY-004-01](../epic-004-client-shell-fsd/stories/story-004-01-vite-react-strict-aliases.md)
- [x] [STORY-001-03 — ESLint 9 flat, Prettier, husky, lint-staged, commitlint](stories/story-001-03-eslint-prettier-husky-commitlint.md) — `done`
- [x] [STORY-001-04 — docker-compose с полным набором dev-сервисов](stories/story-001-04-docker-compose-dev-services.md) — `done`
- [ ] [STORY-001-05 — .env.example и Zod-схема окружения](stories/story-001-05-env-example-zod-schema.md) — `review`: три критерия начинаются со «старта приложения» ([EPIC-003](../epic-003-server-skeleton-and-api-contract/epic.md))
- [ ] [STORY-001-06 — pnpm dev одной командой и quickstart](stories/story-001-06-single-command-dev-and-quickstart.md) — `review`: `:5173` и `GET /health` появятся в EPIC-004 и EPIC-003
- [x] [STORY-001-07 — packages/shared: типы, Zod-примитивы, каталог permissions](stories/story-001-07-shared-package-foundation.md) — `done`

## Почему эпик остаётся в `review`

Четыре истории из семи закрыты. Три оставшиеся упираются в одно и то же: их acceptance-критерии
писались так, как будто EPIC-001 отдаёт работающее приложение, тогда как раздел «Вне скоупа» этого
же эпика отдаёт HTTP-сервер в [EPIC-003](../epic-003-server-skeleton-and-api-contract/epic.md), а
клиентский шелл — в [EPIC-004](../epic-004-client-shell-fsd/epic.md). Пункты вида «сервер отвечает
`200` на `GET /health`», «клиент доступен на `:5173`», «при старте в лог уходит сводка деградаций»
нельзя ни выполнить, ни проверить, не выйдя за границы эпика.

Отметить их выполненными было бы неправдой, переписать критерии задним числом — тоже: они верно
описывают состояние, к которому проект идёт. Поэтому эпик остаётся в `review` до закрытия
STORY-003-01, STORY-003-02, STORY-003-03 и STORY-004-01; каждый открытый пункт выше несёт ссылку на
историю, которая его закроет. Инфраструктурная часть эпика — монорепо, конфиги, линт, dev-стек,
env-схема, `packages/shared` — сделана и проверена на живом окружении.

*Ревизия чекбоксов проведена 2026-07-27.*
