---
id: STORY-011-08
epic: EPIC-011
status: in-progress
blocked: false
priority: must
estimate: L
---

# STORY-011-08 — Эффективные права, кеш и `GET /me/permissions`

**Как** разработчик Bad CRM **я хочу**, чтобы эффективные права пользователя собирались одним
запросом, кешировались по `permissionsVersion` и отдавались клиенту отдельным эндпоинтом, **чтобы**
проверка прав не стоила десяти запросов на каждый HTTP-вызов, а изменение прав отражалось на
следующем же запросе без перелогина.

## Acceptance (Given/When/Then)

1. **Сборка `Actor` одним запросом.**
   Given пользователь с 3 ролями, 2 оверрайдами и членством в 2 командах;
   When вызывается `EffectivePermissionsService.forUser(userId, organizationId)`;
   Then выполняется **один** SQL-запрос (три `LEFT JOIN LATERAL`), покрытый индексом
   `role_permissions (organization_id, role_id) INCLUDE (permission_key)`; возвращается `Actor` с
   `permissions` (роли ∪ ALLOW-оверрайды), `denied` (DENY-оверрайды), `roleIds`, `teamIds`,
   `isOwner`, `permissionsVersion`.

2. **Кеш по версии, а не по TTL.**
   Given ключ `perm:{userId}:{permissionsVersion}` в Redis с TTL 60 c;
   When админ меняет роль пользователя;
   Then версия инкрементится в той же транзакции, старый ключ становится недостижимым, следующий
   запрос собирает права заново — без ожидания TTL.

3. **Одна сборка на HTTP-запрос.**
   Given внутри одного запроса `forUser` вызывается трижды;
   When запрос обрабатывается;
   Then Redis опрашивается один раз: `Actor` лежит в `AsyncLocalStorage` рядом с tenant-контекстом.

4. **Гонка «версия сдвинулась во время сборки».**
   Given версия прочитана как 7, во время сборки стала 8;
   When сборка завершается;
   Then результат **не кладётся** в кеш; следующий запрос собирает заново (тест с искусственной
   задержкой между чтением версии и `load`).

5. **Защита от кеш-штампа.**
   Given у роли 200 носителей и версия сброшена всем одновременно;
   When все они делают запрос;
   Then сборка идёт под коротким локом `perm:lock:{userId}` (`SET NX PX 3000`); не получивший лок
   ждёт до 200 мс и собирает сам; тест на 50 конкурентных сборок не даёт ошибок и укладывается в SLA.

6. **Негативный сценарий — Redis недоступен.**
   Given Redis отключён;
   When выполняется запрос;
   Then `PermissionCachePort` логирует и возвращает `miss`; система работает корректно (не
   deny-всем и не allow-всем), p95 деградирует, метрика `permission_cache_error_total` растёт.

7. **Read-your-writes.**
   Given администратор изменил собственные права и сразу открыл страницу;
   When приходит следующий запрос;
   Then он видит новые права: версия читается из БД (`SELECT permissions_version FROM users WHERE id = $1`),
   а не из кеша, поэтому ключ гарантированно промахивается.

8. **Устаревшая версия в access-токене.**
   Given в токене `permissionsVersion = 5`, в БД — 6;
   When приходит запрос;
   Then токен **не** отвергается: права перечитываются, в ответ добавляется заголовок
   `X-Permissions-Stale: 1`, по которому клиент инвалидирует `me/permissions`. Разлогина не происходит.

9. **`GET /api/v1/me/permissions`.**
   Given аутентифицированный пользователь;
   When он запрашивает эндпоинт;
   Then 200 `{ permissions: PermissionKey[], denied: PermissionKey[], roles: string[], isOwner,
   version }`, заголовки `ETag: "perm-{userId}-{version}"` и `Cache-Control: private, must-revalidate`;
   повторный запрос с `If-None-Match` даёт 304.

10. **Негативный сценарий — чужие права не отдаются.**
    Given пользователь без `permission:override_read`;
    When он запрашивает `GET /api/v1/users/{otherUserId}/permissions`;
    Then 403 `permission_not_granted`; `me/permissions` отдаёт **только** собственные права и не
    принимает параметр `userId`.

11. **Клиент использует ту же функцию.**
    Given `useCan('project:update', { accessLevel: 'EDITOR' })` на клиенте;
    When он вычисляет результат;
    Then вызывается тот же `can()` из `@bad-crm/shared`, что и на сервере; один набор табличных
    тестов прогоняется в обоих пакетах.

12. **Клиент не вычисляет уровень ACL.**
    Given DTO проекта;
    When он сериализуется сервером;
    Then содержит `permissions: { canEdit, canDelete, canManageMembers }`, вычисленные сервером;
    клиент не резолвит цепочку наследования самостоятельно.

13. **Гард маршрута до рендера.**
    Given маршрут `/admin/roles` с `requirePermission('role:read')` в `beforeLoad`;
    When пользователь без права переходит по прямой ссылке;
    Then редирект на экран 403 **до** рендера React; расхождение «UI показал — сервер отказал»
    логируется как продуктовый дефект (метрика `ui_server_permission_mismatch_total`).

## Задачи

- [ ] `packages/server/src/application/access/services/effective-permissions.service.ts`,
      `ports/effective-permissions.port.ts`, `ports/permission-reader.port.ts`,
      `ports/permission-cache.port.ts`.
- [ ] `packages/server/src/infrastructure/persistence/prisma/permission-reader.adapter.ts` +
      `sql/load-actor.query.sql` (один запрос, три `LEFT JOIN LATERAL`, фильтр `expires_at`).
- [ ] `packages/server/src/infrastructure/redis/permission-cache.adapter.ts` — `get/set`, лок
      `SET NX PX 3000`, деградация при ошибке.
- [ ] `packages/server/src/presentation/http/middleware/actor-context.middleware.ts` —
      `AsyncLocalStorage`, сверка версии из токена, заголовок `X-Permissions-Stale`.
- [ ] `packages/server/src/presentation/http/controllers/me.controller.ts` +
      `application/access/queries/get-my-permissions.query.ts`, ETag.
- [ ] `packages/client/src/units/auth/service/queries/me-permissions.query.ts`,
      `units/auth/service/hooks/use-can.hook.ts`, `shared/ui/can.component.tsx`,
      `units/auth/lib/guards/require-permission.guard.ts`.
- [ ] `packages/client/src/shared/lib/enums/query-keys.constant.ts` — `QueryKeys.Auth.permissions()`.
- [ ] Тесты: `effective-permissions.service.spec.ts` (п. 1, 4, 6, 7), интеграционный
      `permission-invalidation.spec.ts` (изменение роли → новые права без перелогина),
      `me-permissions.contract.spec.ts` (ETag, 304, п. 10), клиентские
      `use-can.hook.spec.ts`, `require-permission.guard.spec.ts`, общий набор кейсов `can.spec.ts`
      в `shared` (прогоняется в обоих пакетах).

## Что уже сделано (2026-08-05)

- [x] **`GET /api/v1/me/permissions`** (п. 9) — `{ permissions, denied, roles, isOwner, version }`,
      `ETag: "perm-<userId>-<version>"`, `Cache-Control: private, must-revalidate`, 304 на
      `If-None-Match`. Валидатор — не хеш тела, а **версия решения**: `permissionsVersion`
      инкрементится в транзакции каждого изменения прав, поэтому устаревшая копия невозможна по
      построению, а не по таймауту.
- [x] **Эндпоинт не принимает субъекта** (п. 10): чужие права — это другая операция под
      `permission:override_read`, а маршрут, чья авторизация зависит от аргумента, — это форма,
      которая рано или поздно даёт «забыли проверить для этого значения».
- [x] Актор получил `roleKeys` — для объяснения решения, не для его принятия: проверка по имени роли
      была бы второй точкой истины, которую запрещает инвариант 2.
- [x] Сборка актора уже делается **на каждый запрос** (STORY-011-04), поэтому изменение прав
      действует со следующего запроса без перелогина — п. 7 выполняется без кеша по построению.

Отложено, с причинами:

- **Кеш в Redis (п. 2, 4, 5, 6)** — оптимизация с условием корректности, и условие теперь выполнено
  (версия инкрементится в той же транзакции). Вводить её раньше, чем появится экран, делающий чтение
  горячим, значит добавить лок, деградацию и гонку «версия сдвинулась во время сборки» в код, где
  сегодня один индексированный запрос. Возвращаемся к этому вместе с админкой (011-10/11).
- **`X-Permissions-Stale` (п. 8)** — заголовок нужен клиенту, который кеширует права; пока клиент их
  не кеширует, заголовок был бы контрактом без потребителя.
- **Клиентская половина (п. 11–13)** — `useCan`, `<Can>`, гард маршрута и `me/permissions` в
  TanStack Query: это работа по клиенту, и делать её осмысленно вместе с первым экраном, который
  что-то скрывает (011-10).
- **Один запрос вместо нескольких (п. 1)** — сегодня сборка делает три параллельных чтения через
  Prisma вместо одного `LEFT JOIN LATERAL`; они уходят в одну транзакцию и покрыты индексами. Если
  замер покажет, что это горячий путь, запрос схлопывается в один — но переписывать читаемый код на
  сырой SQL до замера значит платить сложностью за предположение.

## Ссылки

- [`permission-model.md` §7г «EffectivePermissionsService», §7е «Клиент»](../../../docs/security/permission-model.md)
- [`permission-model.md` §8 «Кеширование и инвалидация», «Гонки и как их избегаем» (7 пунктов)](../../../docs/security/permission-model.md)
- [`data-model.md`, `User.permissionsVersion`](../../../docs/architecture/data-model.md)
- [`ux-architecture.md`, «Права в интерфейсе», «Гарды в beforeLoad», «Клиентская проверка — только подсказка»](../../../docs/architecture/ux-architecture.md)
- [`threat-model.md`, `T-IAM-06`](../../../docs/security/threat-model.md)

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
