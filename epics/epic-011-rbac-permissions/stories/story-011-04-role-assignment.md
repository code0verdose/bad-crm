---
id: STORY-011-04
epic: EPIC-011
status: in-progress
blocked: false
priority: must
estimate: M
---

# STORY-011-04 — Назначение и отзыв ролей

**Как** администратор системы (P5) **я хочу** назначать людям роли (в том числе временно, с датой
истечения) и отзывать их одной операцией, **чтобы** доступ появлялся и исчезал предсказуемо и
мгновенно, а организация не могла остаться без владельца или без администратора.

## Acceptance (Given/When/Then)

1. **Назначение роли.**
   Given администратор с `role:assign` и сотрудник Иван без ролей;
   When `POST /api/v1/users/{userId}/roles` с `{ roleId, expiresAt: null }`;
   Then создаётся `UserRole(grantedById, grantedAt)`, инкрементится `users.permissions_version`
   Ивана в той же транзакции, пишется `role.assigned` (`severity = warning`); следующий запрос Ивана
   уже выполняется с новыми правами **без перелогина**.

2. **Временное назначение истекает.**
   Given `UserRole(expiresAt = now + 1h)`;
   When наступает `expiresAt + 1s` и делается запрос;
   Then права роли не применяются: фильтр `(expires_at IS NULL OR expires_at > now())` стоит в
   запросе сборки `Actor`, а не только в джобе-чистильщике; окно ошибки ограничено TTL кеша 60 c.

3. **Отзыв роли.**
   Given у Ивана роль `manager`;
   When `DELETE /api/v1/users/{userId}/roles/{roleId}`;
   Then строка удаляется, версия инкрементится, `role.revoked` в `AuditLog`; попытка выполнить
   действие, которое давала только эта роль, возвращает 403 `permission_not_granted`.

4. **Негативный сценарий — последний владелец.**
   Given в организации ровно один пользователь с ролью `owner`;
   When у него отзывают `owner`;
   Then 409 с `reason = last_owner_required`, строка не удалена. То же правило действует при
   деактивации и удалении пользователя.

5. **Негативный сценарий — самоназначение и эскалация.**
   Given администратор с `role:assign`, но без `invoice:issue`;
   When он назначает себе (или подконтрольному аккаунту) роль `manager`, содержащую `invoice:issue`;
   Then 403 `permission_not_granted`: назначить роль можно, только если её capability —
   подмножество прав назначающего; самоназначение запрещено отдельно (`self_assignment_forbidden`).
   (Митигация `T-IAM-09`.)

6. **Негативный сценарий — самоблокировка.**
   Given администратор снимает с себя роль, которая была единственным источником `role:update`;
   When операция выполняется;
   Then 409 `self_lockout`.

7. **Несколько ролей — объединение.**
   Given Иван с ролями `developer` (даёт `task:update`) и `viewer` (не даёт);
   When вычисляются его права;
   Then `task:update` разрешён; `Role.priority` и порядок в `UserRole` на результат не влияют
   (проверяется тестом, включая обратный порядок вставки).

8. **Идемпотентность назначения.**
   Given у Ивана уже есть роль `developer`;
   When она назначается ещё раз;
   Then 200/204 без дубля (`uq_user_roles`), версия не инкрементится второй раз, лишней записи в
   аудит нет.

9. **Кросс-тенантность.**
   Given `userId` из организации B;
   When администратор организации A назначает ему роль;
   Then **404** `resource_not_found`.

10. **Джоб-чистильщик.**
    Given истёкшие `UserRole` и `UserPermissionOverride`;
    When раз в час отрабатывает `expire-grants.job.ts`;
    Then строки удаляются, версии затронутых пользователей инкрементятся, пишется
    `permission.override.expired` / `role.revoked` с `actorType = SYSTEM`.

## Задачи

- [ ] `packages/server/src/application/iam/use-cases/assign-role.use-case.ts`,
      `revoke-role.use-case.ts`.
- [ ] `packages/server/src/domain/iam/access/role-assignment.policy.ts` — `canAssignRole`
      (подмножество прав назначающего), `assertNotSelfAssignment`, `assertLastOwnerKept`,
      `assertNoSelfLockout`.
- [ ] `packages/server/src/application/iam/ports/user-role-repository.port.ts`,
      `owner-count-reader.port.ts` (дешёвая проверка «последний владелец», см. расхождение №7 §12 —
      денормализованный `Organization.ownerId`).
- [ ] `packages/server/prisma/migrations/*_user_roles/migration.sql` — `user_roles` с
      `uq_user_roles (user_id, role_id)`, `idx_user_roles_org_user`, RLS + политики; колонка
      `organizations.owner_id`.
- [ ] `packages/server/src/application/platform/jobs/expire-grants.job.ts` + отложенная задача
      инвалидации на момент `expiresAt`.
- [ ] `packages/server/src/presentation/http/routes/registry.ts` — `role:assign`, `role:revoke`.
- [ ] Тесты: `role-assignment.policy.spec.ts` (табличный, включая п. 4–7), интеграционные
      `assign-role.spec.ts`, `expire-grants.job.spec.ts`, isolation-тест `user_roles`.

## Что уже сделано (2026-08-05)

- [x] Таблица `user_roles` — миграция `20260805120000_user_roles`: составные внешние ключи на
      пользователя и роль (проверки FK обходят RLS), `granted_by_id` с `ON DELETE SET NULL` — запись
      о назначении обязана пережить того, кто его сделал, — `uq_user_roles (user_id, role_id)`
      (назначить роль дважды — это то же назначение), полный блок RLS и isolation-тест из общего
      генератора.
- [x] `domain/iam/access/role-assignment.policy.ts` — `canAssignRole` (правило подмножества
      `T-IAM-09` + запрет самоназначения) и `canRevokeRole` (последний владелец, самоблокировка),
      чистые функции с табличными тестами. Владелец не проверяется правилом подмножества: его актор
      несёт **пустой** набор прав, потому что владение замыкает слои 1–3, — наивная проверка
      отказала бы единственной учётной записи, которая может всё.
- [x] **Новая причина отказа `self_assignment_forbidden`** — в закрытом списке `DENY_REASONS`,
      в модели прав (с обоснованием, почему это не `self_lockout`), в спецификации и в маппинге на
      403. История называла её с самого начала; в документе её не было — расхождение исправлено в
      документе, а не подгонкой кода под существующий список.

- [x] `AssignRoleUseCase` и `RevokeRoleUseCase`: 404 до policy (чужой `userId`/`roleId` не
      подтверждается), затем policy, затем запись + инкремент `permissions_version` + запись в
      журнал — всё в одной транзакции. Идемпотентность означает «ничего не произошло»: повторное
      назначение не двигает версию и не пишет в журнал.
- [x] Счётчик владельцев берётся **внутри транзакции** и с исключением субъекта — это вопрос
      «сколько владельцев останется», а не «сколько есть»; иначе два параллельных отзыва оба видят
      двух владельцев.
- [x] Маршруты `POST /users/{userId}/roles` и `DELETE /users/{userId}/roles/{roleId}` с правами
      `role:assign` / `role:revoke`, спека и типы клиента обновлены.
- [x] `require-permission.middleware` + сборка актора (`BuildActorQuery`,
      `PrismaEffectivePermissionsReader`): права читаются **на каждый запрос**, поэтому назначение
      действует со следующего запроса без перелогина. Порядок гвардов — аутентификация впереди
      capability (обратный порядок давал 500 вместо 401, поймано тестом).

Осталось: джоб-чистильщик истёкших грантов (`expire-grants.job.ts`). Он не влияет на корректность —
фильтр `expiresAt IS NULL OR expiresAt > now()` стоит в самих чтениях, поэтому истёкшая роль не
действует независимо от джоба; джоб убирает строки и пишет `role.revoked` с `actorType = SYSTEM`, и
приходит вместе с очередями (EPIC-021). Оверрайды (`denied`) — пустое множество до STORY-011-05.

## Ссылки

- [`permission-model.md` §2, `UserRole` и инвариант «минимум один владелец»](../../../docs/security/permission-model.md)
- [`permission-model.md` §5, краевые случаи 4, 5, 11](../../../docs/security/permission-model.md)
- [`permission-model.md` §8 «Что инкрементит permissionsVersion», «Гонки»](../../../docs/security/permission-model.md)
- [`threat-model.md`, `T-IAM-06`, `T-IAM-09`](../../../docs/security/threat-model.md)
- PRD: риск `R-15`

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
