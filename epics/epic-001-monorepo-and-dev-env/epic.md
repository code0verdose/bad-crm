---
id: EPIC-001
title: Монорепо и dev-окружение
status: backlog
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
- `docker-compose.yml`: PostgreSQL 16 + pgvector, Redis 7, MinIO, Meilisearch, mailhog — с healthcheck и именованными томами.
- `.env.example` со всеми переменными и Zod-схема `env`, парсящаяся один раз при старте.
- `pnpm dev` — одна команда до работающего локального стека; quickstart в `README.md`.
- `packages/shared`: базовые branded-типы, Zod-примитивы, каталог кодов ошибок, заготовка каталога permissions.

### Вне скоупа

- Production-образы, multi-stage Dockerfile и self-host-поставка — [EPIC-017](../epic-017-self-host-alpha/epic.md) (M2).
- Сам CI-пайплайн и гейт коммита — [EPIC-002](../epic-002-ci-and-commit-gate/epic.md).
- Prisma-схема и миграции — [EPIC-003](../epic-003-server-skeleton-and-api-contract/epic.md).
- Роли БД `app_user` / `app_migrator` / `app_auth` — [EPIC-005](../epic-005-multi-tenancy-rls/epic.md).

## Acceptance (эпик выполнен, когда)

- [ ] `pnpm install && pnpm docker:up && pnpm dev` на чистой машине с Node 22 и Docker 24 приводит к работающим клиенту и серверу без ручных шагов сверх копирования `.env.example` → `.env`.
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm test` выполняются из корня и проходят на пустом скелете.
- [ ] Turborepo кеширует повторный `pnpm build`/`pnpm typecheck`: второй прогон без изменений завершается из кеша (FULL TURBO).
- [ ] Направление зависимостей соблюдено: `shared` не импортирует ничего из `packages/*`, `e2e` не импортирует исходники `server`/`client`; нарушение падает на линте.
- [ ] Все контейнеры `docker-compose.yml` имеют healthcheck, зафиксированные версии образов и именованные тома; `pnpm docker:up` ждёт готовности сервисов.
- [ ] Старт сервера с неполным `.env` падает с внятным сообщением о конкретной переменной, а не работает «наполовину».
- [ ] Коммит с сообщением вне Conventional Commits отклоняется локальным хуком.
- [ ] `packages/shared` собирается и импортируется и из `server`, и из `client`; в нём нет Node-only и браузерных API.

## Зависимости / риски

- Зависит от: нет (стартовый эпик майлстоуна M1).
- Блокирует: [EPIC-002](../epic-002-ci-and-commit-gate/epic.md), [EPIC-003](../epic-003-server-skeleton-and-api-contract/epic.md), [EPIC-004](../epic-004-client-shell-fsd/epic.md), [EPIC-005](../epic-005-multi-tenancy-rls/epic.md), [EPIC-009](../epic-009-observability/epic.md), [EPIC-010](../epic-010-e2e-harness/epic.md).
- Риски: **R-14** (сложность самохостинга — 6 сервисов в compose): митигация — разумные дефолты, healthcheck, профиль `minimal`, quickstart, замер времени старта. **R-08** (scope creep): эпик строго ограничен скелетом, доменного кода в нём нет.

## Ссылки

- Документация: [`stack.md` → Раскладка монорепо](../../docs/architecture/stack.md), [`stack.md` → Требования к среде](../../docs/architecture/stack.md), [`stack.md` → Конфигурация и env](../../docs/architecture/stack.md), [`overview.md` → Развёртывание](../../docs/architecture/overview.md), [`prd.md` → NFR-3](../../docs/product/prd.md)
- Правила: `rules/naming-and-structure.mdc`, `rules/dependencies.mdc`, `rules/tdd-and-commit-gate.mdc`

## Истории

- [ ] [STORY-001-01 — pnpm workspaces и turborepo pipeline](stories/story-001-01-pnpm-workspaces-turborepo.md)
- [ ] [STORY-001-02 — tsconfig.base.json strict и path-алиасы](stories/story-001-02-tsconfig-base-strict-aliases.md)
- [ ] [STORY-001-03 — ESLint 9 flat, Prettier, husky, lint-staged, commitlint](stories/story-001-03-eslint-prettier-husky-commitlint.md)
- [ ] [STORY-001-04 — docker-compose с полным набором dev-сервисов](stories/story-001-04-docker-compose-dev-services.md)
- [ ] [STORY-001-05 — .env.example и Zod-схема окружения](stories/story-001-05-env-example-zod-schema.md)
- [ ] [STORY-001-06 — pnpm dev одной командой и quickstart](stories/story-001-06-single-command-dev-and-quickstart.md)
- [ ] [STORY-001-07 — packages/shared: типы, Zod-примитивы, каталог permissions](stories/story-001-07-shared-package-foundation.md)
