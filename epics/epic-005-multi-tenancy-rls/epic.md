---
id: EPIC-005
title: Мультиарендность и Row Level Security
status: review
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

- [x] Каждая таблица с `organization_id` имеет `ENABLE` + `FORCE ROW LEVEL SECURITY`, политику `tenant_isolation` с `USING` и явным `WITH CHECK`, политику обслуживания для `app_migrator` и явные `GRANT` — без `ALTER DEFAULT PRIVILEGES`.
- [x] Структурный CI-тест по каталогу `pg_policy`/`pg_class` падает при появлении таблицы с `organization_id` без политики, без `FORCE` или с неканоническим предикатом. *В CI это интеграционный тест (`test/integration/db/migrations.test.ts`, job `database isolation`); на живом хосте тот же аудит запускается как `pnpm check:rls` — см. [STORY-005-02](stories/story-005-02-rls-policies-and-set-config.md). Канонический шаблон один на двоих, второе определение падает тестом.*
- [x] Для каждой мультиарендной таблицы автоматически генерируются тесты: чтение, обновление, удаление, список и счётчик чужой строки дают пустой результат либо ошибку; вставка с чужим `organization_id` отклоняется; **своя строка при этом видна** (положительный контроль).
- [x] Приложение подключается ролью `app_user` без `BYPASSRLS`, не является владельцем таблиц и не может выполнить `SET ROLE app_migrator`; несоответствие валит старт.
- [x] Запрос к данным арендатора вне `withTenant` падает на предохранителе, а не возвращает чужие строки.
- [x] Прямой вызов `prisma.*` вне `infrastructure/persistence` падает на линте.
- [x] Создание организации и её первого владельца выполняется одной транзакцией; при сбое на любом шаге не остаётся ни организации без владельца, ни владельца без организации. *Владелец создаётся через `UserRepositoryPort`; его Prisma-адаптер приезжает вместе с таблицей `users` в [STORY-006-01](../epic-006-auth-core/stories/story-006-01-organization-and-owner-registration.md).*
- [x] Чек-лист «новая таблица» задокументирован и включён в шаблон миграции и в ревью `db-reviewer`. *Чек-лист в [`rls-design.md`](../../docs/security/rls-design.md) дополнен пунктами 9a и 10; ревьюер внутри репозитория — проектный агент `tenancy-rls-auditor`. Пункт для общего агента `db-reviewer` не добавлен: он живёт вне репозитория, см. [STORY-005-05](stories/story-005-05-database-roles-separation.md).*

## Зависимости / риски

- Зависит от: [EPIC-003](../epic-003-server-skeleton-and-api-contract/epic.md) (Prisma, миграции, харнесс Testcontainers), [EPIC-001](../epic-001-monorepo-and-dev-env/epic.md) (docker-стек, env).
- Блокирует: [EPIC-006](../epic-006-auth-core/epic.md) и все доменные эпики — ни одна мультиарендная таблица не создаётся до этого эпика.
- Риски: **R-01** (ошибка в RLS → кросс-тенантная утечка) — основной риск проекта; митигации: RLS до доменных таблиц, обязательный блок в шаблоне миграции, структурный CI-чек, генерируемые негативные тесты, роль без `BYPASSRLS`, проверка роли при старте, отдельная позиция в чек-листе `db-reviewer`. Дополнительный риск — падение производительности из-за предиката политики: митигируется правилом «`organization_id` — первая колонка составных индексов» и замером плана на реалистичном объёме.

## Ссылки

- Документация: [`rls-design.md`](../../docs/security/rls-design.md) (полностью — источник правды), [`data-model.md` → Мульти-тенантность и RLS](../../docs/architecture/data-model.md), [`overview.md` → (а) Tenancy и RLS](../../docs/architecture/overview.md), [ADR-0004](../../docs/architecture/adr/0004-multi-tenancy-postgres-rls.md), [`prd.md` → NFR-1, риск R-01](../../docs/product/prd.md)
- Правила: `rules/tenancy-rls.mdc`, `rules/security.mdc`, `rules/testing.mdc`

## Истории

- [x] [STORY-005-01 — Модель Organization, миграция и tenant-контекст](stories/story-005-01-organization-model-and-tenant-context.md)
- [x] [STORY-005-02 — RLS-политики и выставление контекста через set_config](stories/story-005-02-rls-policies-and-set-config.md)
- [x] [STORY-005-03 — База tenant-scoped репозитория и запрет прямых prisma.*](stories/story-005-03-tenant-scoped-repository-base.md)
- [x] [STORY-005-04 — Набор тестов изоляции с положительным контролем](stories/story-005-04-cross-tenant-isolation-test-suite.md)
- [x] [STORY-005-05 — Роли БД app_user / app_migrator / app_auth](stories/story-005-05-database-roles-separation.md)
- [x] [STORY-005-06 — Bootstrap организации и первого владельца в одной транзакции](stories/story-005-06-organization-bootstrap-transaction.md)

> **Что вынесено из эпика явно.** Каждая история несёт ссылку на перенос; сводно это: middleware
> tenant-контекста и `source-of-truth`-тест — [EPIC-006](../epic-006-auth-core/epic.md) (нет сессии);
> обёртка `runJob` — эпик очередей (нет BullMQ); путь `bypassRls` с записью в аудит и событие аудита
> при bootstrap — [STORY-016-02](../epic-016-audit-log/stories/story-016-02-audit-logger-port.md)
> (нет журнала); раздельные политики append-only журналов и отзыв прав на них —
> [STORY-016-01](../epic-016-audit-log/stories/story-016-01-append-only-table.md) (нет таблиц);
> `DATABASE_AUTH_URL` и клиент `app_auth` —
> [STORY-006-02](../epic-006-auth-core/stories/story-006-02-login-access-and-refresh-cookie.md)
> (нет `SECURITY DEFINER`-функций, ради которых роль существует); `Idempotency-Key`, контроллер и
> Prisma-адаптеры `users`/`roles` —
> [STORY-006-01](../epic-006-auth-core/stories/story-006-01-organization-and-owner-registration.md);
> isolation-тест для таблицы с наследуемым `organization_id` — до появления первой такой таблицы.
> Ни один перенос не про «не успели»: во всех случаях предмет проверки ещё не существует, а
> заглушка ради галочки — это тест, который проходит на отсутствии кода.
