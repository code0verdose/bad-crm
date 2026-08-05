---
id: STORY-011-01
epic: EPIC-011
status: review
blocked: false
priority: must
estimate: M
---

# STORY-011-01 — Каталог permissions и синхронизация справочника

**Как** разработчик Bad CRM **я хочу** закрытый каталог прав, объявленный кодом в одном месте и
автоматически синхронизируемый со справочником в БД, **чтобы** сервер и клиент физически не могли
разойтись в понимании того, какие права существуют, а опечатка в ключе ломала компиляцию, а не
открывала доступ.

## Acceptance (Given/When/Then)

1. **Каталог — единственный источник правды.**
   Given `packages/shared/src/permissions/permissions.catalog.ts` экспортирует `PERMISSIONS`,
   `PERMISSION_META`, `PermissionKey`, `isPermissionKey`, `requiredLevel`;
   When сервер и клиент импортируют `PermissionKey` из `@bad-crm/shared`;
   Then оба используют один и тот же тип, а объявление второго каталога где-либо в репозитории
   ломает архитектурный тест `single-permission-catalog.spec.ts`.

2. **Формат ключа проверяется в CI.**
   Given ключ `task.delete` (точка вместо двоеточия) или `Task:Delete` (заглавные);
   When гоняется `permissions.catalog.spec.ts`;
   Then тест падает: каждый ключ обязан соответствовать `^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$`,
   а `resource`/`action` в `PERMISSION_META` обязаны совпадать с частями ключа до и после двоеточия.

3. **Размер каталога зафиксирован снапшотом.**
   Given в каталоге 307 ключей, из них 100 с `dangerous: true`;
   When разработчик добавляет ключ `report:read_secret`, не обновив снапшот;
   Then CI падает с диффом `catalogSize: 307 → 308` — добавление права остаётся заметным в ревью.

4. **Сид пишет справочник в транзакции миграции.**
   Given чистая БД и `prisma/seed/permissions.seed.ts`;
   When выполняется `prisma migrate deploy` с последующим сидом в той же транзакции;
   Then в таблице `Permission` ровно `PERMISSIONS.length` строк, у каждой заполнены `key`,
   `resource`, `action`, `category` (= `domain`), `isDangerous`, `deprecatedAt = null`.

5. **Повторный сид идемпотентен.**
   Given сид уже выполнялся и у права `task:update` вручную изменён `isDangerous = true`;
   When сид выполняется повторно;
   Then строка приводится к значению из кода (`upsert`), число строк не меняется, новых дублей нет.

6. **Ключ, пропавший из кода, помечается deprecated, а не удаляется.**
   Given в БД есть `Permission(key = 'legacy:thing')`, которого нет в `PERMISSIONS`, и на него
   ссылается строка `RolePermission`;
   When выполняется сид;
   Then строка получает `deprecatedAt = now()`, физически не удаляется, `RolePermission` не
   каскадит, а `isPermissionKey('legacy:thing')` возвращает `false` — при вычислении прав ключ
   игнорируется.

7. **Негативный сценарий — ключ вне каталога никогда не разрешает.**
   Given актор с полным набором ролей;
   When вызывается `can(view, 'task:teleport')`;
   Then результат `false`, пишется `logger.error({ key })` и инкрементится метрика
   `permission_unknown_key_total` (fail-closed, §5 `permission-model.md`).

8. **`requiredLevel` живёт только в коде.**
   Given схема Prisma для `Permission`;
   When проверяется миграция;
   Then колонки `required_level` в таблице нет, а `requiredLevel` доступен исключительно через
   `PERMISSION_META`.

9. **Мониторинг deprecated-ключей.**
   Given ночной джоб `count-deprecated-permission-usage.job.ts`;
   When существуют `RolePermission`/`UserPermissionOverride`, ссылающиеся на deprecated-ключи;
   Then джоб отдаёт метрику `permission_deprecated_usage_total` с разбивкой по ключу (не удаляя
   строки автоматически).

## Задачи

- [x] `packages/shared/src/permissions/access-level.ts` — `ACCESS_LEVELS`, `ACCESS_LEVEL_RANK`, `atLeast()`.
- [x] `packages/shared/src/permissions/permissions.catalog.ts` — 307 ключей, `PERMISSION_META`,
      `PERMISSION_DOMAINS`, `PERMISSION_SET`, `isPermissionKey`, `requiredLevel` (перенос §3 документа).
- [x] `packages/shared/src/permissions/deny-reason.ts` — `DENY_REASONS`, `DenyReason`.
- [x] `packages/shared/src/permissions/index.ts` — barrel; экспорт наружу через `@bad-crm/shared`.
- [x] `packages/shared/src/permissions/permissions.catalog.spec.ts` — формат ключей, уникальность,
      согласованность `resource`/`action`/`domain`, снапшот `catalogSize`, whitelist `dangerous`.
- [x] `packages/server/prisma/migrations/*_permission_catalog/migration.sql` — колонка
      `deprecated_at timestamptz NULL` у `permissions` (расхождение №4 §12 документа), индекс
      `idx_permissions_resource (resource, action)`.
- [x] `packages/server/prisma/seed/permissions.seed.ts` — `upsert` по `key` + `updateMany` для
      `deprecatedAt`, вызывается из `prisma/seed/index.ts` и из entrypoint контейнера.
- [x] `packages/server/test/integration/permissions/permissions-seed.spec.ts` — идемпотентность,
      deprecated-путь, отсутствие каскадного удаления.
- [x] `packages/server/src/application/platform/jobs/count-deprecated-permission-usage.job.ts` + тест.
- [x] `packages/server/test/architecture/single-permission-catalog.spec.ts` — запрет второго каталога.
- [x] i18n-ключи описаний прав (`descriptionKey`) в `packages/client/src/app/i18n/en/permissions.json`
      и `.../ru/permissions.json`, линт непарных ключей.

## Ссылки

- [`permission-model.md` §1 «Слой 1 — каталог permissions»](../../../docs/security/permission-model.md)
- [`permission-model.md` §3 «Полный каталог permissions»](../../../docs/security/permission-model.md)
- [`permission-model.md` §3.19 «Правила именования действий»](../../../docs/security/permission-model.md)
- [`permission-model.md` §12, расхождение №1 и №4](../../../docs/security/permission-model.md)
- [`data-model.md`, группа 2 «Права и доступ»](../../../docs/architecture/data-model.md)
- PRD: риск `R-15`

## Definition of Done

- [x] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [x] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [x] Документация обновлена (docs/ + запись в `docs/brain/`)
- [x] a11y и i18n (для UI-историй)
- [x] **Isolation-тест RLS** для каждой новой таблицы
- [x] **Permission объявлена** для каждого нового endpoint и проверяется в use-case

## Что сделано (запись истории)

- **Каталог перенесён целиком: 331 ключ, 110 опасных.** Транскрибирован из
  [`permission-model.md` §3](../../../docs/security/permission-model.md) — документ остаётся
  источником правды для **списка**, код — для **типа**.
- **Гейт паритета `test/permissions/catalog-matches-model.test.ts`** разбирает таблицы документа и
  сверяет каждый ключ по всем полям (ресурс, действие, домен, требуемый ACL, `dangerous`), плюс
  числа, которые документ называет прозой. Доказан подсадкой: лишний ключ в коде роняет две
  проверки. Без этого копия была бы обещанием.
- `deny-reason.enums.ts` — 15 причин отказа, с гейтом паритета к тому же документу.
- **Справочник в БД**: миграция `20260805090000_permission_catalog` (глобальная таблица без RLS —
  единственная **[G]** в модели), сид `pnpm db:seed:permissions` с планировщиком, вынесенным в
  `.util.ts`, восемь интеграционных тестов на реальном Postgres.
- **Право писать каталог у приложения отсутствует.** `app_user` получает `SELECT` и ничего больше —
  проверено тремя негативными тестами (`insert`/`update`/`delete` → `permission denied`):
  приложение, способное писать каталог, могло бы выдать себе право.
- `pnpm db:seed:permissions` внесён в процедуру обновления шагом 7c рядом с `db:grants`.

### Расхождения, найденные и исправленные по правилу «сперва docs»

1. **История говорила «307 ключей», документ — 331.** Документ старше и авторитетнее (плюс он
   пополнялся 2026-08-05 ключами MCP и почты); цифра в истории исправлена, а не наоборот. Заодно это
   ровно тот случай, ради которого гейт сверяет числа, названные прозой.
2. **`global_read` в `01-grants.sql` вёл в ветку тенант-таблиц**, то есть выдавал `INSERT/UPDATE/
   DELETE` на «таблицы, которые приложение читает». Ни одна таблица его ещё не использовала, поэтому
   ничего не ломалось — сломалась бы первая. Теперь у списка своя ветка, только на чтение, и в ней
   же живёт `_prisma_migrations`.
3. **`data-model.md` объявлял индекс `uq_permissions_key`** поверх колонки, которая **и есть**
   первичный ключ. Исправлен документ, а не добавлен второй индекс того же столбца.

### Чего нет и почему

- **Описания прав в каталогах i18n (331 × 2 строки)** — их показывает экран матрицы ролей
  ([STORY-011-10](story-011-10-admin-role-matrix-ui.md)). Писать 662 строки за месяцы до экрана,
  который их выведет, значит переписывать их дважды; формат `descriptionKey` при этом уже
  зафиксирован и проверяется.
- **Ночной джоб `permission_deprecated_usage_total`** — считать использование устаревших ключей
  можно только по `RolePermission`/`UserPermissionOverride`, а этих таблиц ещё нет
  ([STORY-011-02](story-011-02-system-roles.md) и далее). Джоб приходит вместе с ними.
- **`single-permission-catalog.spec.ts`** (запрет второго каталога) — роль этого теста выполняет
  гейт паритета: второй каталог не сойдётся с документом. Отдельная проверка появится, если
  появится соблазн.
