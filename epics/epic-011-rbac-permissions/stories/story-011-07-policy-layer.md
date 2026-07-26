---
id: STORY-011-07
epic: EPIC-011
status: backlog
blocked: false
priority: must
estimate: L
---

# STORY-011-07 — Policy-слой, порты доступа и реестр маршрутов

**Как** разработчик Bad CRM **я хочу**, чтобы решение о доступе принималось в единственном месте —
чистой policy-функции домена, возвращающей `Decision { allowed, reason }`, а ни один маршрут не мог
существовать без объявленного права, **чтобы** забытая проверка ломала CI, а не превращалась в IDOR
внутри организации.

## Acceptance (Given/When/Then)

1. **Policy — чистая функция.**
   Given `packages/server/src/domain/project/access/project-access.policy.ts`;
   When гоняется архитектурный тест;
   Then модуль не импортирует Prisma, Express, Redis, `process.env`, не вызывает `Date.now()`;
   покрытие строк и ветвей — 100 % (табличные тесты).

2. **Decision несёт причину, а не «forbidden».**
   Given актор без права `project:update` и актор с правом, но уровнем `VIEWER`;
   When вызывается `canUpdateProject`;
   Then в первом случае `{ allowed: false, reason: 'permission_not_granted' }`, во втором —
   `'insufficient_acl_level'`; `assertAllowed` превращает их в 403 с разными `type`-URI
   `problem+json` (RFC 9457) и в разные записи `AuditLog`.

3. **Порядок проверок: capability → ресурс.**
   Given актор без capability и несуществующий `resourceId`;
   When вызывается `can()`;
   Then отказ происходит до обращения к БД за ACL — запрос к `resource_acl` не выполняется вовсе
   (проверяется счётчиком SQL); по времени ответа «нет права» и «нет объекта» неразличимы.

4. **404 вместо 403 для чужого и несуществующего.**
   Given `access.projectScope(id)` вернул `null` (объекта нет, удалён или чужой тенант);
   When выполняется use-case;
   Then `NotFoundError('resource_not_found')` → HTTP **404**, содержимое объекта не читается ни разу
   (порядок «сначала scope, потом `findById`» проверяется тестом на порядок вызовов).

5. **Access-reader не возвращает сущность.**
   Given `ProjectAccessReaderPort.projectScope(projectId)`;
   When он вызывается;
   Then возвращается только `{ projectId, organizationId, aclLevel, visibility, leadId, isDeleted }`,
   без описания, бюджета и прочих полей; архитектурный тест запрещает reader'у возвращать
   доменные агрегаты.

6. **Middleware — fail-fast, а не авторитет.**
   Given маршрут `PATCH /api/v1/projects/:projectId` с `requirePermission('project:update')`;
   When приходит запрос от актора без capability;
   Then 403 до парсинга тела и до обращения к БД; при наличии capability запрос идёт дальше, и
   **ACL проверяет use-case** — middleware `resourceId` не резолвит.

7. **Реестр маршрутов обязателен.**
   Given `ROUTE_REGISTRY` в `presentation/http/routes/registry.ts`;
   When разработчик регистрирует в Express маршрут, отсутствующий в реестре;
   Then CI падает (сравнение стека Express с реестром), сообщение называет метод и путь.

8. **Негативный сценарий — маршрут без права.**
   Given запись реестра без `permission` и без `public: true`;
   When проверяются типы;
   Then код не компилируется (`satisfies readonly RouteDeclaration[]`); запись с `public: true`, но
   пустым `publicReason` валит тест `route-registry.spec.ts`.

9. **Негативный сценарий — маршрут с `:id` без `aclCheckedIn`.**
   Given запись `{ method: 'DELETE', path: '/projects/:projectId', permission: 'project:delete' }`
   без `aclCheckedIn`;
   When гоняется `acl-coverage.spec.ts`;
   Then тест падает; при указанном `aclCheckedIn` тест проверяет, что такой класс существует и
   вызывает `assertAllowed`.

10. **Негативный сценарий — вторая точка вычисления прав.**
    Given в контроллере появилось `if (user.role === 'admin')` или ручной разбор массива
    `permissions` на клиенте мимо `can()`;
    When гоняется архитектурный тест и агент `permission-matrix-auditor`;
    Then вердикт `FAIL`, коммит блокируется (прямая митигация `R-15`).

11. **Неаутентифицированный и заблокированный vault.**
    Given запрос без сессии → DENY `not_authenticated` → 401; Given vault заблокирован →
    DENY `vault_locked` → 423;
    When выполняется `can()`;
    Then коды и причины соответствуют таблице fail-closed §5.

## Задачи

- [ ] `packages/shared/src/permissions/can.ts` — `CapabilityView`, `effectivePermission`, `can()`
      (единственная реализация, импортируется сервером и клиентом).
- [ ] `packages/server/src/domain/access/decision.types.ts`, `decision.ts` (`allow`, `deny`,
      `assertAllowed`), `actor.types.ts`, `explain-denial.ts`.
- [ ] `packages/server/src/domain/access/access.errors.ts` — маппинг `DenyReason` → HTTP
      (401/403/404/423/503) в `presentation/http/error-handler.ts`.
- [ ] `packages/server/src/domain/project/access/project-access.policy.ts` и
      `packages/server/src/domain/iam/access/*.policy.ts` — эталонные policy.
- [ ] `packages/server/src/application/project/ports/project-access-reader.port.ts` +
      `infrastructure/persistence/prisma/project-access-reader.adapter.ts`.
- [ ] `packages/server/src/presentation/http/middleware/require-permission.middleware.ts`.
- [ ] `packages/server/src/presentation/http/routes/registry.ts` — `RouteDeclaration`,
      `ROUTE_REGISTRY`, подключение маршрутов **только** из реестра.
- [ ] Тесты: `project-access.policy.spec.ts` (таблица истинности §5 целиком + 12 краевых случаев),
      `route-registry.spec.ts`, `acl-coverage.spec.ts`, `no-second-authorization-point.spec.ts`,
      `require-permission.middleware.spec.ts`, `sql-query-count.spec.ts` (п. 3).
- [ ] Агент `permission-matrix-auditor` в `.claude/agents/` + подключение в commit-гейт
      ([EPIC-002](../../epic-002-ci-and-commit-gate/epic.md)).

## Ссылки

- [`permission-model.md` §5 «Слой 5 — итоговое решение», fail-closed правила](../../../docs/security/permission-model.md)
- [`permission-model.md` §7 «Реализация по слоям» (а)–(д)](../../../docs/security/permission-model.md)
- [`permission-model.md` §9в «CI-правило „нет маршрута без объявленной permission“», §9г агент](../../../docs/security/permission-model.md)
- [`stack.md`, «Backend: гексагональная архитектура», порты](../../../docs/architecture/stack.md)
- [`ux-architecture.md`, «403 vs 404»](../../../docs/architecture/ux-architecture.md)
- [`threat-model.md`, `T-TENANT-05`, `T-TASK-02`](../../../docs/security/threat-model.md)

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
