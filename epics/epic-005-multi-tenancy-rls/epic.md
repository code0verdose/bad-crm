---
id: EPIC-005
title: Мультиарендность и Row Level Security
status: backlog
blocked: false
milestone: M1
owner: unassigned
created: 2026-07-26
---

# EPIC-005 — Мультиарендность и Row Level Security

## Зачем (ценность)

Кросс-тенантная утечка — единственный дефект, который в этом продукте считается критическим
безусловно и блокирует релиз. Полагаться на то, что ни в одном из сотен запросов не будет забыт
`where organizationId`, нельзя. Эпик вводит изоляцию арендаторов на уровне PostgreSQL — до того, как
появится хоть одна доменная таблица, — и делает её невозможной к обходу: роль приложения без
`BYPASSRLS`, `FORCE ROW LEVEL SECURITY`, контекст только внутри транзакции, автоматический тест на
каждую таблицу с `organization_id` и структурный CI-чек, валящий сборку при таблице без политики.

## Scope

### В скоупе

- Модель `Organization`, первая мультиарендная миграция, tenant-контекст через `AsyncLocalStorage`.
- RLS-политики по каноническому шаблону (`ENABLE` + `FORCE` + `USING` + `WITH CHECK` + явный `GRANT`), выставление контекста через `set_config(..., true)` внутри транзакции (`Prisma $extends`).
- База tenant-scoped репозитория и предохранитель `guardedClient`; ESLint-запрет прямых `prisma.*` вне `infrastructure/persistence`.
- Полный набор тестов изоляции — чтение, запись, обновление, удаление, список, счётчик — плюс положительный контроль «своя строка видна».
- Роли БД `app_user` / `app_migrator` / `app_auth`, bootstrap-скрипт, проверка роли при старте.
- Bootstrap организации: создание организации и первого владельца в одной транзакции.

### Вне скоупа

- Модель прав (capability + ACL) — [EPIC-011](../epic-011-rbac-permissions/epic.md): RLS отвечает «чья это организация», а не «имеет ли пользователь право».
- Аутентификация и выдача токенов — [EPIC-006](../epic-006-auth-core/epic.md) (здесь только контракт «`organizationId` берётся из сессии»).
- Изоляция поискового индекса — [EPIC-024](../epic-024-search-meilisearch/epic.md).
- Обход RLS для фоновых rollup-джобов — соответствующие эпики, здесь только флаг `bypassRls` с обязательной записью в аудит.

## Acceptance (эпик выполнен, когда)

- [ ] Каждая таблица с `organization_id` имеет `ENABLE` + `FORCE ROW LEVEL SECURITY`, политику `tenant_isolation` с `USING` и явным `WITH CHECK`, политику обслуживания для `app_migrator` и явные `GRANT` — без `ALTER DEFAULT PRIVILEGES`.
- [ ] Структурный CI-тест по каталогу `pg_policy`/`pg_class` падает при появлении таблицы с `organization_id` без политики, без `FORCE` или с неканоническим предикатом.
- [ ] Для каждой мультиарендной таблицы автоматически генерируются тесты: чтение, обновление, удаление, список и счётчик чужой строки дают пустой результат либо ошибку; вставка с чужим `organization_id` отклоняется; **своя строка при этом видна** (положительный контроль).
- [ ] Приложение подключается ролью `app_user` без `BYPASSRLS`, не является владельцем таблиц и не может выполнить `SET ROLE app_migrator`; несоответствие валит старт.
- [ ] Запрос к данным арендатора вне `withTenant` падает на предохранителе, а не возвращает чужие строки.
- [ ] Прямой вызов `prisma.*` вне `infrastructure/persistence` падает на линте.
- [ ] Создание организации и её первого владельца выполняется одной транзакцией; при сбое на любом шаге не остаётся ни организации без владельца, ни владельца без организации.
- [ ] Чек-лист «новая таблица» задокументирован и включён в шаблон миграции и в ревью `db-reviewer`.

## Зависимости / риски

- Зависит от: [EPIC-003](../epic-003-server-skeleton-and-api-contract/epic.md) (Prisma, миграции, харнесс Testcontainers), [EPIC-001](../epic-001-monorepo-and-dev-env/epic.md) (docker-стек, env).
- Блокирует: [EPIC-006](../epic-006-auth-core/epic.md) и все доменные эпики — ни одна мультиарендная таблица не создаётся до этого эпика.
- Риски: **R-01** (ошибка в RLS → кросс-тенантная утечка) — основной риск проекта; митигации: RLS до доменных таблиц, обязательный блок в шаблоне миграции, структурный CI-чек, генерируемые негативные тесты, роль без `BYPASSRLS`, проверка роли при старте, отдельная позиция в чек-листе `db-reviewer`. Дополнительный риск — падение производительности из-за предиката политики: митигируется правилом «`organization_id` — первая колонка составных индексов» и замером плана на реалистичном объёме.

## Ссылки

- Документация: [`rls-design.md`](../../docs/security/rls-design.md) (полностью — источник правды), [`data-model.md` → Мульти-тенантность и RLS](../../docs/architecture/data-model.md), [`overview.md` → (а) Tenancy и RLS](../../docs/architecture/overview.md), [ADR-0004](../../docs/architecture/adr/0004-multi-tenancy-postgres-rls.md), [`prd.md` → NFR-1, риск R-01](../../docs/product/prd.md)
- Правила: `rules/tenancy-rls.mdc`, `rules/security.mdc`, `rules/testing.mdc`

## Истории

- [ ] [STORY-005-01 — Модель Organization, миграция и tenant-контекст](stories/story-005-01-organization-model-and-tenant-context.md)
- [ ] [STORY-005-02 — RLS-политики и выставление контекста через set_config](stories/story-005-02-rls-policies-and-set-config.md)
- [ ] [STORY-005-03 — База tenant-scoped репозитория и запрет прямых prisma.*](stories/story-005-03-tenant-scoped-repository-base.md)
- [ ] [STORY-005-04 — Набор тестов изоляции с положительным контролем](stories/story-005-04-cross-tenant-isolation-test-suite.md)
- [ ] [STORY-005-05 — Роли БД app_user / app_migrator / app_auth](stories/story-005-05-database-roles-separation.md)
- [ ] [STORY-005-06 — Bootstrap организации и первого владельца в одной транзакции](stories/story-005-06-organization-bootstrap-transaction.md)
