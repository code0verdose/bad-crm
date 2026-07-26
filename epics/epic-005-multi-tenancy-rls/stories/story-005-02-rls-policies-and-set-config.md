---
id: STORY-005-02
epic: EPIC-005
status: backlog
blocked: false
priority: must
estimate: L
---

# STORY-005-02 — RLS-политики и выставление контекста через set_config

**Как** владелец инсталляции **я хочу** чтобы изоляция организаций держалась на PostgreSQL, а не на
аккуратности разработчика **чтобы** забытый `WHERE` не превращался в утечку данных заказчика к
другому арендатору.

## Acceptance (Given/When/Then)

- **Given** таблица с `organization_id` **When** применена её миграция **Then** в каталоге БД присутствуют: `relrowsecurity = true`, `relforcerowsecurity = true`, политика `tenant_isolation` для роли `app_user` с непустыми `USING` и `WITH CHECK`, политика `maintenance_access` для `app_migrator`, явные `GRANT` для `app_user`.
- **Given** установленный контекст организации A **When** выполняется `SELECT` строки организации B по её `id` **Then** возвращается 0 строк — не ошибка, не данные.
- **Given** установленный контекст организации A **When** выполняется `INSERT` со значением `organization_id` организации B **Then** запрос отклоняется нарушением `WITH CHECK` (`new row violates row-level security policy`).
- **Given** установленный контекст организации A **When** выполняется `UPDATE`, меняющий `organization_id` своей строки на организацию B **Then** запрос отклоняется `WITH CHECK`.
- **Given** транзакция, где выполнен `set_config('app.organization_id', …, true)` **When** транзакция завершается и соединение возвращается в пул **Then** следующий запрос из пула не видит прежнего значения GUC (проверяется тестом с явным переиспользованием соединения).
- **Given** запрос вне транзакции с контекстом **When** политика не находит `app.organization_id` **Then** он не возвращает ни одной строки и/или падает — «пусто» является безопасным исходом по умолчанию.
- **Given** новая PERMISSIVE-политика с неканоническим предикатом, добавленная на мультиарендную таблицу **When** запускается структурный CI-чек **Then** он падает: дополнительная политика обязана содержать предикат арендатора либо быть `AS RESTRICTIVE`.
- **Given** таблица с `organization_id`, добавленная без блока RLS **When** запускается миграционный чек по каталогу БД **Then** сборка падает с именем таблицы и перечнем недостающих элементов.

## Задачи

- [ ] Написать тесты первыми (Testcontainers): `test/integration/rls/policy-shape.test.ts` (структурная проверка каталога `pg_class`/`pg_policy` для всех `[T]`-таблиц), `test/integration/rls/set-config.test.ts` (локальность GUC, поведение вне транзакции, переиспользование соединения), `test/integration/rls/with-check.test.ts` (вставка и «переезд» строки в чужую организацию).
- [ ] Реализовать шаблон миграции с пятью обязательными блоками (`ENABLE`, `FORCE`, `tenant_isolation`, `maintenance_access`, `GRANT`) и генератор/сниппет для его вставки.
- [ ] Реализовать `infrastructure/persistence/prisma/tenant-client.ts`: `withTenant(base, ctx, fn)` — интерактивная транзакция + `set_config('app.organization_id', $1, true)` и `set_config('app.user_id', $2, true)`, помещение транзакции в ALS.
- [ ] Реализовать `guardedClient(base)` через `$extends` — запрос без контекста бросает ошибку до обращения к БД.
- [ ] Реализовать особый случай политики для `organizations` (предикат по собственному `id`) и для append-only журналов (раздельные политики по командам, без `UPDATE`/`DELETE`).
- [ ] Реализовать `scripts/rls-catalog-check.ts` — сверка списка таблиц с `organization_id` против каталога политик; ненулевой код при расхождении; подключить в CI.
- [ ] Настроить `statement_timeout`, `idle_in_transaction_session_timeout`, `lock_timeout` на ролях (пересекается с [STORY-005-05](story-005-05-database-roles-separation.md)).
- [ ] Добавить `grep`-чек: в кодовой базе нет `SET` без `LOCAL` для наших GUC и нет `set_config` с `is_local = false`.

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, **db-reviewer обязателен**, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y-проверка (для UI-историй) — не применимо
- [ ] i18n: строки в обоих языках, хардкода нет (для UI-историй) — не применимо

## Ссылки

- Документация: [`rls-design.md` → Канонический шаблон политики, Ловушки, Автоматизация](../../../docs/security/rls-design.md), [`data-model.md` → Шаблон политики](../../../docs/architecture/data-model.md), [ADR-0004](../../../docs/architecture/adr/0004-multi-tenancy-postgres-rls.md)
- Правила: `rules/tenancy-rls.mdc`, `rules/security.mdc`
