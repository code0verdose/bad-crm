---
id: STORY-011-05
epic: EPIC-011
status: in-progress
blocked: false
priority: must
estimate: L
---

# STORY-011-05 — Персональные исключения прав по пользователю

**Как** администратор системы (P5) **я хочу** точечно разрешить или запретить конкретному человеку
конкретное право — с обязательной причиной и сроком, **чтобы** закрыть требование ТЗ «кастомно по
каждому юзеру», не клонируя роль ради одного отличия и не превращая матрицу в сорок ролей вида
`manager_without_finance_2`.

## Acceptance (Given/When/Then)

1. **DENY отбирает право, выданное ролью.**
   Given Иван с ролью `manager` (даёт `invoice:issue`);
   When создаётся `UserPermissionOverride(userId=Иван, key='invoice:issue', effect=DENY,
   reason='передал биллинг Петру на время декрета', expiresAt=null)`;
   Then `can(actor, 'invoice:issue')` = `false` с `reason = denied_by_override`; запрос к
   `POST /api/v1/invoices/{id}/issue` возвращает 403 с этой причиной.

2. **ALLOW выдаёт право, которого нет ни в одной роли.**
   Given Пётр с ролью `developer` (без `time:read_team`);
   When создаётся override `ALLOW` на `time:read_team` с `expiresAt = now + 30d`;
   Then право работает немедленно после инвалидации кеша и перестаёт работать после `expiresAt`
   (проверяется на `expiresAt + 1s` без ожидания джоба — фильтр стоит в запросе).

3. **Причина обязательна и содержательна.**
   Given запрос с `reason = "нужно"` (6 символов);
   When он приходит на `POST /api/v1/users/{userId}/permission-overrides`;
   Then 422: Zod требует `reason` длиной ≥ 10 после `trim`, БД страхует
   `CHECK (length(btrim(reason)) >= 10)`. Ни одна строка не создана.

4. **Одно мнение об одном праве.**
   Given у Ивана уже есть override `DENY` на `invoice:issue`;
   When создаётся `ALLOW` на тот же ключ;
   Then запись **обновляется** (upsert по `uq_user_permission_overrides (user_id, permission_key)`),
   а не добавляется вторая; в `AuditLog` — `permission.override.updated` с `before`/`after`.

5. **DENY побеждает всё, кроме владельца.**
   Given таблица истинности §5: строки 3, 9 и 14;
   When гоняются табличные тесты policy;
   Then при `role=да, override=DENY, acl≥требуемого` → DENY `denied_by_override`; при
   `override=DENY, acl=NONE` → DENY `denied_by_override` (capability проверяется первой);
   при `isOwner = true` и найденной в БД строке DENY → **ALLOW** + `logger.error` + метрика
   `permission_owner_deny_found_total`.

6. **Негативный сценарий — DENY на владельца запрещён на записи.**
   Given пользователь с активной ролью `owner`;
   When создаётся override `effect = DENY` на любой ключ;
   Then 409 с `reason = owner_immutable`; страховка — триггер `ck_upo_not_owner` в БД, отклоняющий
   вставку даже при прямом SQL.

7. **Негативный сценарий — самоблокировка.**
   Given администратор создаёт себе `DENY` на `permission:override` или `role:update`;
   When операция выполняется;
   Then 409 `self_lockout`.

8. **Негативный сценарий — эскалация через override.**
   Given администратор без права `vault_item:export`;
   When он выдаёт `ALLOW` на `vault_item:export` себе или другому;
   Then 403 `permission_not_granted` — выдать можно только то, что есть у выдающего;
   для `dangerous`-ключей дополнительно требуется подтверждение (`X-Confirm-Dangerous`).

9. **Дефолт UI для ALLOW — срочный.**
   Given форма создания исключения в админке;
   When выбран `effect = ALLOW`;
   Then `expiresAt` предзаполнен значением +30 дней, а «бессрочно» требует явного снятия галочки;
   для `DENY` срок опционален.

10. **Отложенная инвалидация.**
    Given выдан `ALLOW` с `expiresAt = now + 2h`;
    When создаётся запись;
    Then ставится отложенная задача инвалидации на момент `expiresAt` (инкремент
    `permissionsVersion`), а часовой джоб-чистильщик работает как страховка.

11. **Кросс-тенантность.**
    Given `userId` из организации B;
    When администратор организации A создаёт исключение;
    Then **404** `resource_not_found`.

## Задачи

- [ ] `packages/server/prisma/migrations/*_user_permission_overrides/migration.sql` — таблица с
      `effect OverrideEffect`, `reason` + CHECK, `expiresAt`, `uq_user_permission_overrides`,
      частичный `idx_upo_expires (expires_at) WHERE expires_at IS NOT NULL`, триггер
      `ck_upo_not_owner`, RLS `ENABLE` + `FORCE` + политики.
- [ ] `packages/server/src/application/iam/use-cases/upsert-permission-override.use-case.ts`,
      `delete-permission-override.use-case.ts`.
- [ ] `packages/server/src/application/iam/queries/list-user-permission-overrides.query.ts` —
      три состояния на ключ: ALLOW / DENY / наследовано (с указанием роли-источника).
- [ ] `packages/server/src/domain/iam/access/permission-override.policy.ts` — `canOverride`,
      `assertNotOwnerDeny`, `assertNoSelfLockout`, `assertSubsetOfGranterPermissions`.
- [ ] `packages/server/src/presentation/http/validators/permission-override.validator.ts` —
      `reason` (min 10 после `trim`), `effect`, `expiresAt`, `.strict()`.
- [ ] `packages/server/src/presentation/http/routes/registry.ts` — `permission:override`,
      `permission:override_read`.
- [ ] Тесты: `permission-override.policy.spec.ts` (таблица истинности §5, строки 1–16),
      интеграционные `permission-overrides-api.spec.ts` (п. 3, 4, 6, 7, 8, 11),
      `owner-deny-anomaly.spec.ts` (п. 5, ветка 14), isolation-тест таблицы.
- [ ] OpenAPI: `/users/{userId}/permission-overrides`.

## Что уже сделано (2026-08-05)

- [x] Таблица `user_permission_overrides` — миграция `20260805130000_user_permission_overrides`:
      `effect ALLOW|DENY`, `CHECK (length(btrim(reason)) >= 10)`, `uq (user_id, permission_key)`
      (одно мнение об одном праве — свойство схемы, а не договорённости), частичный `idx_upo_expires`,
      триггер `ck_upo_not_owner` и полный блок RLS. Составные FK, как везде.
- [x] `domain/iam/access/permission-override.policy.ts` — `canWriteOverride`/`canRemoveOverride`:
      DENY на владельца (`owner_immutable`), правило подмножества **только для ALLOW** (отобрать —
      не способ получить), самоблокировка на `permission:override`/`role:update`, и асимметрия
      снятия: снять DENY с себя — это `self_assignment_forbidden`, а не lockout.
- [x] Use-cases (upsert + удаление), репозиторий, инкремент `permissions_version`, записи в журнал
      (`permission.override.created/updated/deleted`) с `reason` в `before`/`after`.
- [x] Маршруты `PUT`/`DELETE /users/{userId}/permission-overrides/{permission}` с правом
      `permission:override`, спека и типы клиента. Параметр называется `permission`, а не
      `permissionKey`: контрактный тест отвергает параметры пути, чьё имя похоже на учётные данные,
      и «key» — одно из его слов.
- [x] Оверрайды попали в сборку актора: ALLOW добавляется к правам, DENY возвращается отдельно
      (`denied_by_override` — это другой ответ, чем «никто не выдавал»), обе половины — с тем же
      фильтром истечения, что и роли.
- [x] Новая причина отказа `owner_immutable` — в закрытом списке, в модели прав, в спеке, в кодах
      ошибок (409) и в обоих переводах.
- [x] Тесты: табличные по policy, аргументы репозитория, восемь HTTP-сценариев, и отдельный
      интеграционный набор на триггер — включая попытку превратить ALLOW в DENY через `UPDATE`.

Осталось: список исключений с источником-ролью (`list-user-permission-overrides.query.ts`) и экран
админки — вместе со STORY-011-11; отложенная инвалидация на момент `expiresAt` (п. 10) — вместе с
очередями EPIC-021, до тех пор истечение действует немедленно за счёт фильтра в запросах;
подтверждение `X-Confirm-Dangerous` для опасных ключей (п. 8) — вместе с UI, который его отправляет.

## Ссылки

- [`permission-model.md` §2 «Слой 3 — per-user overrides»](../../../docs/security/permission-model.md)
- [`permission-model.md` §5 «Таблица истинности» и краевые случаи 1, 2, 11](../../../docs/security/permission-model.md)
- [`permission-model.md` §10 «Аудит», строка `permission.override.*`](../../../docs/security/permission-model.md)
- [`threat-model.md`, `T-IAM-09`](../../../docs/security/threat-model.md)
- PRD: риск `R-15`, пункт 3 скоупа ТЗ

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
