# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Security fixes are additionally published as GitHub Security Advisories; see
[`SECURITY.md`](SECURITY.md). New or changed environment variables are always listed here **and** in
[`docs/runbooks/upgrade.md`](docs/runbooks/upgrade.md), because self-hosted administrators upgrade
from this file.

---

## [Unreleased]

Nothing is released yet. The project is in **phase 0**: the specification and the work breakdown
exist, the application does not. No `packages/`, no `docker-compose.yml`, no image, no version tag.

### Added — Phase 0: спецификация проекта

**Продуктовые документы** (`docs/product/`, 3 файла)

- `prd.md` — проблема и цель, персоны и JTBD, скоуп по MoSCoW, North Star Metric и контрметрики,
  риски R-01…R-15, явный out-of-scope.
- `roadmap.md` — девять майлстоунов M1–M9 с составом эпиков, пользовательской ценностью, критериями
  выхода и зависимостями.
- `glossary.md` — ubiquitous language EN/RU: термин домена = имя Prisma-модели = корень FSD-unit'а =
  имя в контракте API.

**Архитектурные документы** (`docs/architecture/`, 4 файла + 21 ADR)

- `overview.md` — C4 уровни 1–3, ограниченные контексты, сквозные механизмы (tenancy, авторизация,
  outbox, файлы, realtime, поиск, AI, observability), границы доверия, развёртывание.
- `stack.md` — стек с версиями и обоснованиями, раскладка монорепо, гексагональные слои сервера,
  contract-first API, работа с БД и RLS, outbox и очереди, безопасность в коде, конфигурация и env,
  наблюдаемость, тестовая стратегия, команды, политика зависимостей и лицензий.
- `data-model.md` — сущности, таблицы, индексы, RLS-политики; источник истины по именам.
- `ux-architecture.md` — принципы интерфейса, информационная архитектура, карта маршрутов, ключевые
  экраны, дизайн-система, паттерны взаимодействия, права в UI, доступность WCAG 2.1 AA, локализация,
  адаптивность и производительность.
- `adr/0001`…`adr/0021` — 21 запись Architecture Decision Record: монорепо, гексагональный backend,
  OpenAPI как источник истины, мультиарендность через RLS, FSD «units», Mantine + CSS Modules,
  TanStack Router и Query, модель прав RBAC + ACL, иерархия ключей E2EE, Socket.IO + Redis, поиск с
  учётом прав, редактор BlockNote, Markdown как источник истины KB, абстракция AI-провайдера,
  S3-хранилище и presigned URL, единая модель записи времени, Mantine Charts, лицензия AGPL-3.0,
  i18n EN/RU, упаковка для self-host, транзакционный outbox.

**Документы безопасности** (`docs/security/`, 4 файла)

- `threat-model.md` — область моделирования, активы, нарушители N1–N8, границы доверия, STRIDE по
  контекстам, топ-15 угроз, prompt injection, утечка через поиск, presigned URL, supply chain,
  специфика self-host, персональные данные, остаточные риски RR-01…RR-07, план проверки.
- `rls-design.md` — три роли БД и bootstrap, канонический шаблон политики, особые случаи
  (`organizations`, append-журналы, партиции, наследование `organization_id`, представления),
  `withTenant` и `guardedClient`, автоматизация против забывчивости, обязательные isolation-тесты,
  особые пути (логин, анонимная ссылка, воркеры), миграции и RLS, производительность, чек-лист
  «новая таблица», известные ограничения.
- `permission-model.md` — пять слоёв модели (каталог permissions, роли, per-user overrides, resource
  ACL, единая точка вычисления), матрица роль × endpoint, отвергнутые альтернативы.
- `e2ee-design.md` — обещание и его границы, иерархия ключей, параметры примитивов и защита от
  downgrade, что хранится на сервере и что не хранится никогда, полный жизненный цикл (регистрация,
  разблокировка, создание, чтение, шаринг, отзыв и ротация, смена и сброс пароля, офбординг,
  Recovery Kit, org escrow), blind index, защищённые ссылки ONE_TIME и RESTRICTED, интеграция с
  остальной системой, правила для разработчиков, модель угроз vault, план реализации.

**Правила разработки** (`rules/`, 34 файла `.mdc`)

Обязательные всегда (`alwaysApply: true`): `tdd-and-commit-gate`, `ci-before-push`, `commit-hygiene`,
`epic-driven-development`, `agent-orchestration`, `naming-and-structure`, `tenancy-rls`,
`permissions`, `security`, `i18n`, `a11y`, `frontend-fsd`, `hexagonal-backend`, `testing`.

По области изменений: `api-contract`, `zod-validation`, `db-migrations`, `outbox`,
`polymorphic-access`, `tanstack-query`, `lists-and-filters`, `design-system`, `errors-and-toasts`,
`editor-content`, `realtime`, `search-index`, `file-uploads`, `import-export`, `observability`,
`e2ee-crypto`, `ai-providers`, `time-tracking-invariants`, `self-host-packaging`, `dependencies`.

**Проектные агенты-ревьюеры** (`.claude/agents/`, 9 файлов)

`tenancy-rls-auditor`, `permission-matrix-auditor`, `e2ee-crypto-reviewer`,
`openapi-contract-guardian`, `fsd-architecture-linter`, `realtime-event-reviewer`,
`search-permission-auditor`, `i18n-coverage-checker`, `selfhost-upgrade-checker` — каждый только
читает дельту и отчитывается, код не редактирует.

**Декомпозиция работ** (`epics/`, 159 файлов)

- 46 эпиков (`epic.md`) — по одному на каталог `epic-NNN-<slug>/`, с frontmatter
  (`id`/`status`/`blocked`/`milestone`/`owner`), ценностью, scope in/out, критериями приёмки,
  зависимостями и рисками.
- 113 пользовательских историй (`stories/story-NNN-XX-<slug>.md`) — написаны для майлстоунов M1 и M2
  (эпики EPIC-001 … EPIC-017), с критериями Given/When/Then, чек-листом задач и Definition of Done.
  Истории майлстоунов M3–M9 создаются на kickoff соответствующего майлстоуна.

**Корневые документы и runbooks**

- `CLAUDE.md` — рабочее соглашение: три неприкосновенных инварианта, порядок источников истины,
  CI-before-push, карта «какой файл читать когда», стек, workflow эпиков, commit-гейт, команды,
  раскладка пакетов и нейминг, таблица проектных агентов, чувствительность данных.
- `README.md` и `README.ru.md` — публичное описание проекта на английском и русском с честным
  статусом фазы проектирования.
- `CONTRIBUTING.md` — окружение, структура репозитория, обязательный TDD, commit-гейт, Conventional
  Commits, обязательность `rules/*.mdc`, процесс эпиков и историй, код-ревью, DCO 1.1, Definition of
  Done (ключевые разделы продублированы по-русски).
- `SECURITY.md` — поддерживаемые версии, приватный канал приёма уязвимостей и сроки ответа, скоуп и
  out-of-scope, координированное раскрытие за 90 дней, раздел о гарантиях и не-гарантиях E2EE-vault,
  чек-лист безопасной self-host установки.
- `CODE_OF_CONDUCT.md` — Contributor Covenant 2.1.
- `CHANGELOG.md` — этот файл.
- `docs/README.md` — Map of Docs: карта всей документации, схема связей, разделение источников истины.
- `docs/api/README.md` — contract-first флоу, генерация типов, правила изменения контракта.
- `docs/runbooks/install.md`, `upgrade.md`, `backup-restore.md`, `incident.md` — операционные
  инструкции self-host: установка и чек-лист безопасности, обновление и откат, бэкап и
  восстановление, реакция на инциденты.

**Прочее в репозитории**

`LICENSE` (AGPL-3.0), `.editorconfig`, `.gitignore`, `.npmrc`, `.nvmrc` (Node 22).

### Not yet present

`packages/` (`shared`, `server`, `client`, `e2e`), `package.json`, `pnpm-workspace.yaml`,
`turbo.json`, `tsconfig.base.json`, `eslint.config.js`, `docker-compose.yml`, `Dockerfile`,
`.env.example`, `docs/api/openapi.yaml`, `epics/README.md` (борд эпиков — генерируемый файл),
CI-воркфлоу. Всё перечисленное создаётся эпиками майлстоуна M1, начиная с EPIC-001.

---

<!--
  Release sections go here, newest first, e.g.:

  ## [0.1.0] — YYYY-MM-DD
  ### Added / Changed / Deprecated / Removed / Fixed / Security
  ### Environment variables
  ### Migration notes
-->
