---
date: 2026-07-28
project: bad-crm
tags: [PostgreSQL, Row Level Security, ESLint, Vitest, Testcontainers, esquery, UUID, ULID]
---

# Закрытие находок аудита мультиарендности (EPIC-005)

Аудит `tenancy-rls-auditor` дал PASS и восемь замечаний. Четыре из них — гейты, которые не падали
в направлении отказа: проверка есть, но её ветка отказа никогда не исполнялась. Закрыты шесть
(W1–W6, W8); каждая — падающим тестом сначала и мутацией кода после.

## Простым языком

1. **Проверка роли БД при старте** умела отказывать роли, которая может «стать» владельцем схемы,
   но в тестовом контейнере ни одна роль не член другой — эта ветка ни разу не выполнялась.
   Добавил интеграционный спек, который реально выдаёт `GRANT app_migrator TO app_user`, ждёт
   отказа старта и снимает грант в `finally`. Зачем: оператор, объединивший роли «чтобы миграции
   ходили одной ролью», получал зелёный старт и полный обход изоляции одним `SET ROLE`.
2. **Isolation-тест на вставку** проверял только отказ чужой вставки. Код ошибки `42501` — это и
   нарушение политики, и «нет прав», поэтому таблица, на которой приложению вообще не выдали
   `INSERT`, проходила тест. Добавил положительный контроль «своя вставка проходит». Зачем: иначе
   забытый `GRANT` читается как «политика работает».
3. **`pnpm check:rls`** судил только политики, адресованные `app_user`. Широкая политика для
   владельца схемы давала ноль находок — и после ручного ремонта на staging любое подключение
   миграций снова видело все организации. Теперь проверяется любая PERMISSIVE-политика на
   tenant-таблице, для любой роли; допустимых предикатов два — tenant-предикат и
   maintenance-переключатель.
4. **Шаблон предиката** разрешал сравнение и по `id`, и по `organization_id` любой таблице, хотя
   реестр знает нужную колонку для каждой. Теперь ожидаемая колонка приходит из реестра. Зачем: не
   утечка (выборка пустеет), но диагностируется как «данных нет» — самый дорогой симптом.
5. **Правило обещало запрет линтера**, которого не было: массивная форма `$transaction([...])`
   проходила линт. Запрет реализован, с фикстурой и положительным контролем на интерактивную форму.
6. **«Репозиторий не принимает `organizationId`»** держалось на дисциплине. Теперь это запрет
   линтера: параметр или поле с таким именем в `*.repository.ts`, плюс запрет импорта клиента БД
   вне композиционного корня.
7. **Расхождение правила и кода про формат id** решено в пользу кода: правило требовало `uuidv7()`,
   адаптер отдаёт `randomUUID()` (v4). Сортируемость ключей здесь ничего не покупает — единственный
   генерируемый приложением ключ это id организации, — а `docs/architecture/data-model.md` (источник
   истины выше правил) уже санкционирует `gen_random_uuid()` как текущий компромисс. Правило
   приведено к коду; адаптер переименован из `ulid-*` в `system-id-generator`, потому что половина
   его поверхности отдавала uuid.

## Технически

1. `packages/server/test/integration/db/assert-db-role.test.ts:96` — спек `GRANT app_migrator TO
   app_user` через `superuser`-пул, ожидание единственной причины отказа
   (`the role may SET ROLE app_migrator…`), `REVOKE` в `finally` + контроль восстановления.
   Мутация `'MEMBER'` → `'USAGE'` в `assert-db-role.util.ts:120` роняет только этот спек.
2. `packages/server/test/integration/db/rls-isolation.test.ts:142` — `CONTROL: the tenant may insert
   its own row`, под `it.runIf(spec.appUserPrivileges.includes('INSERT'))`, через
   `ROW_FACTORIES[table]` под `asTenant`; для корня тенанта используется свежий uuid (bootstrap-путь).
3. `rls-catalog.util.ts` — блок проверки PERMISSIVE перенесён из цикла по `tenantPolicies` в цикл по
   всем политикам таблицы; RESTRICTIVE пропускаются; проверяются оба предиката (`USING`, `WITH
   CHECK`). Новый `CANONICAL_MAINTENANCE_PREDICATE` в `rls-catalog.constant.ts` — второе каноническое
   выражение, вынесено туда же, чтобы определение оставалось единственным
   (`rls-catalog-sources.test.ts` расширен идентификатором `current_setting\('app\.maintenance'`).
4. `rls-catalog.constant.ts:47` — `CANONICAL_TENANT_PREDICATE` из одной RegExp стал
   `Readonly<Record<TenantColumn, RegExp>>`; `String.raw`, чтобы исходник по-прежнему содержал
   литерал, который ищет sources-тест. Колонка приходит из реестра
   (`registry[table]?.tenantColumn ?? 'organization_id'`).
5. `eslint.config.js` — `ARRAY_TRANSACTION`
   (`CallExpression[callee.property.name='$transaction'][arguments.0.type='ArrayExpression']`)
   в блоках `SERVER`, `SERVER_PERSISTENCE`, `SERVER_REPOSITORIES`.
6. `eslint.config.js` — `REPOSITORY_TAKES_NO_TENANT` (пять esquery-селекторов: позиционный параметр,
   параметр со значением по умолчанию, TS parameter property, деструктуризация, поле класса) для
   `packages/server/src/**/*.repository.ts`; `DB_CLIENT_OUTSIDE_COMPOSITION_ROOT` — запрет импорта
   `prisma.client.js` / `database.factory.js` вне `infrastructure/bootstrap/**`, с точечными
   переобъявлениями (не `'off'`) для `database.factory.ts` и композиционного корня.
7. `system-id-generator.adapter.ts` (переименован из `ulid-id-generator.adapter.ts`), класс
   `SystemIdGeneratorAdapter`; в `system-id-generator.test.ts` закреплена версия uuid (`[14] === '4'`),
   чтобы переход на v7 требовал одновременного пересмотра `rules/tenancy-rls.mdc` §17.

## Применённые технологии

- [[PostgreSQL]] — `pg_has_role(…, 'MEMBER')` против `'USAGE'` для `NOINHERIT`-ролей, `pg_policy`,
  `polpermissive`, `pg_get_expr`; `42501` как общий код для политики и привилегии.
- [[Row Level Security]] — PERMISSIVE складываются по OR **внутри роли**; RESTRICTIVE — по AND.
- [[ESLint]] — flat config, `no-restricted-syntax` поверх [[esquery]], переобъявление правила вместо
  `'off'`, чтобы исключение оставалось узким.
- [[Vitest]] + [[Testcontainers]] — интеграционные пробы `check:rls` на живом каталоге.
- [[UUID]] / [[ULID]] — разделение корреляционных идентификаторов и ключей сущностей.

## Связи

- Проект: [[Projects/bad-crm]]
- Related: [[2026-07-28--tenant-repository-and-startup-role-check]],
  [[2026-07-28--rls-catalog-check-script]]
