---
id: STORY-011-01
epic: EPIC-011
status: backlog
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

- [ ] `packages/shared/src/permissions/access-level.ts` — `ACCESS_LEVELS`, `ACCESS_LEVEL_RANK`, `atLeast()`.
- [ ] `packages/shared/src/permissions/permissions.catalog.ts` — 307 ключей, `PERMISSION_META`,
      `PERMISSION_DOMAINS`, `PERMISSION_SET`, `isPermissionKey`, `requiredLevel` (перенос §3 документа).
- [ ] `packages/shared/src/permissions/deny-reason.ts` — `DENY_REASONS`, `DenyReason`.
- [ ] `packages/shared/src/permissions/index.ts` — barrel; экспорт наружу через `@bad-crm/shared`.
- [ ] `packages/shared/src/permissions/permissions.catalog.spec.ts` — формат ключей, уникальность,
      согласованность `resource`/`action`/`domain`, снапшот `catalogSize`, whitelist `dangerous`.
- [ ] `packages/server/prisma/migrations/*_permission_catalog/migration.sql` — колонка
      `deprecated_at timestamptz NULL` у `permissions` (расхождение №4 §12 документа), индекс
      `idx_permissions_resource (resource, action)`.
- [ ] `packages/server/prisma/seed/permissions.seed.ts` — `upsert` по `key` + `updateMany` для
      `deprecatedAt`, вызывается из `prisma/seed/index.ts` и из entrypoint контейнера.
- [ ] `packages/server/test/integration/permissions/permissions-seed.spec.ts` — идемпотентность,
      deprecated-путь, отсутствие каскадного удаления.
- [ ] `packages/server/src/application/platform/jobs/count-deprecated-permission-usage.job.ts` + тест.
- [ ] `packages/server/test/architecture/single-permission-catalog.spec.ts` — запрет второго каталога.
- [ ] i18n-ключи описаний прав (`descriptionKey`) в `packages/client/src/app/i18n/en/permissions.json`
      и `.../ru/permissions.json`, линт непарных ключей.

## Ссылки

- [`permission-model.md` §1 «Слой 1 — каталог permissions»](../../../docs/security/permission-model.md)
- [`permission-model.md` §3 «Полный каталог permissions»](../../../docs/security/permission-model.md)
- [`permission-model.md` §3.19 «Правила именования действий»](../../../docs/security/permission-model.md)
- [`permission-model.md` §12, расхождение №1 и №4](../../../docs/security/permission-model.md)
- [`data-model.md`, группа 2 «Права и доступ»](../../../docs/architecture/data-model.md)
- PRD: риск `R-15`

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
