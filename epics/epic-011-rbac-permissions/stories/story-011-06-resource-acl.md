---
id: STORY-011-06
epic: EPIC-011
status: backlog
blocked: false
priority: must
estimate: L
---

# STORY-011-06 — ACL на ресурс и наследование по цепочке

**Как** руководитель проекта (P2) **я хочу** выдавать доступ к конкретному объекту — проекту, папке,
документу — конкретному человеку, роли или команде, с уровнем от «смотреть» до «управлять»,
**чтобы** закрыть один документ внутри общего проекта или, наоборот, впустить подрядчика ровно в
одну папку, не трогая роли всей организации.

## Acceptance (Given/When/Then)

1. **Выдача и чтение записи ACL.**
   Given руководитель с `acl:grant` и уровнем `MANAGER` на проекте `BAD`;
   When `POST /api/v1/acl` с `{ resourceType: 'PROJECT', resourceId, subjectType: 'TEAM',
   subjectId: teamBackend, accessLevel: 'EDITOR', expiresAt: null }`;
   Then создаётся `ResourceAcl`, инкрементится `permissions_version` **всем членам команды**,
   пишется `acl.granted` в `AuditLog` (`severity = warning`).

2. **Ближайшая явная запись побеждает.**
   Given `PROJECT → TEAM=backend → EDITOR` и `DOC_PAGE(внутри) → USER=ivan → VIEWER`, Иван в команде
   backend;
   When резолвится уровень Ивана на этом документе;
   Then `VIEWER`: обход снизу вверх останавливается на первом узле с записями. Правка запрещена,
   чтение разрешено. Обратная раскладка (`VIEWER` на проекте, `EDITOR` на документе) даёт `EDITOR`
   на этом документе и `VIEWER` на остальных.

3. **`NONE` — явный запрет на узле и ниже.**
   Given `PROJECT → TEAM=backend → EDITOR` и `KB_SPACE → USER=ivan → NONE`;
   When Иван открывает заметку внутри этого пространства;
   Then **404** (`acl_explicit_none` внутри, наружу — `resource_not_found`): существование закрытого
   пространства не подтверждается; все заметки внутри наследуют тот же `NONE`.

4. **Максимум на одном узле.**
   Given на одном узле `TEAM → EDITOR` и `USER → VIEWER` для одного актора;
   When резолвится уровень;
   Then `EDITOR` (максимум); понижение конкретного человека выражается только `NONE` либо записью на
   более близком узле — это зафиксированное ограничение шкалы.

5. **Просроченные записи не учитываются.**
   Given `ResourceAcl(expiresAt = now - 1s)`;
   When резолвится уровень;
   Then запись игнорируется как отсутствующая; при отсутствии других — применяется `implicitLevel`.

6. **`implicitLevel` вместо «разрешено всем».**
   Given ни одной записи ACL по всей цепочке;
   When актор — `ProjectMember(projectRole = MEMBER)` публичного проекта → `EDITOR`;
   `REVIEWER` → `COMMENTER`; `OBSERVER` → `VIEWER`; не участник публичного проекта → `VIEWER`;
   не участник приватного → `NONE` (→ 404); роль `guest` → всегда `NONE`;
   Then результат соответствует таблице §5 `permission-model.md` (проверяется табличным тестом на
   все 13 строк).

7. **Владелец обходит ACL, кроме vault.**
   Given `owner` и `ResourceAcl(PROJECT, USER=owner, NONE)`;
   When резолвится уровень на задаче этого проекта;
   Then `MANAGER` — обход не выполняется; для `resourceType ∈ {VAULT, VAULT_ITEM}` авторитет —
   `VaultMembership`, и `resolveAcl` к `ResourceAcl` не обращается вовсе.

8. **Один запрос, а не N.**
   Given документ на глубине 4 (DocPage → parent → Project → Organization);
   When резолвится уровень;
   Then выполняется **один** SQL-запрос (`WITH chain(...) VALUES ... JOIN resource_acl ... ORDER BY
   depth LIMIT 1`), цепочка предков строится разбором `path` (materialized path); тест считает
   число SQL-запросов на эндпоинт.

9. **Негативный сценарий — оборванная иерархия.**
   Given `DocPage.parentPageId` указывает на удалённую страницу;
   When резолвится уровень;
   Then `ancestorChain` возвращает `null` → `accessReader` отдаёт `null` → **404** + `logger.warn`
   с `resourceId`; «разрешить по организации» не происходит никогда.

10. **Негативный сценарий — ошибка резолва.**
    Given БД недоступна во время резолва ACL;
    When выполняется `can()` для права с `requiredLevel ≠ null`;
    Then DENY с `reason = acl_resolution_failed` и HTTP **503**; «не смогли проверить» ≠ «разрешено».

11. **Негативный сценарий — выдача доступа шире собственного.**
    Given руководитель с уровнем `EDITOR` на проекте;
    When он выдаёт кому-то `MANAGER` на этот проект;
    Then 403 — `acl:grant` требует `MANAGER` на ресурсе, выдать уровень выше собственного нельзя.

12. **Списки не резолвят построчно.**
    Given список из 200 задач;
    When он строится;
    Then множество доступных родителей вычисляется **один раз** и подставляется в
    `WHERE project_id = ANY($accessible)` с вычитанием поддеревьев `NONE`; интеграционный тест
    «список = фильтр по `can()` построчно» на малом наборе данных проходит.

13. **Удаление роли снимает её записи ACL** (перенесено из STORY-011-03).
    Given кастомная роль `tech_writer` с записью `ResourceAcl (subjectType = ROLE, subjectId = роль)`
    на проекте;
    When роль удаляется через `DELETE /api/v1/roles/{roleId}`;
    Then в той же транзакции исчезают и записи ACL этой роли, и `permissions_version`
    инкрементится всем, кто получал доступ через них. Осиротевшая запись ACL, ссылающаяся на
    несуществующую роль, — это доступ, который никто не может ни увидеть, ни отозвать из интерфейса.
    В 011-03 требование выполнить было нечем: таблицы ACL не существовало ни у одного домена.

## Задачи

- [ ] `packages/server/prisma/migrations/*_resource_acl/migration.sql` — таблица `resource_acl`,
      enum `AclResourceType` (включая `ORGANIZATION`, `TASK`, `KB_NOTE`, `FILE`, `CHANNEL`,
      `DASHBOARD` — расхождение №5 §12), `AclSubjectType`, `AccessLevel`; `uq_resource_acl`,
      `idx_resource_acl_subject`, `idx_resource_acl_resource`; RLS `ENABLE` + `FORCE` + политики.
- [ ] `packages/server/src/domain/access/acl-resolution.ts` — чистая функция
      `resolveFromChain(entriesByDepth, implicit): AccessLevel` (правила «ближайший», `NONE`,
      максимум) — без I/O, покрытие 100 %.
- [ ] `packages/server/src/domain/access/implicit-level.ts` — таблица `implicitLevel` из §5.
- [ ] `packages/server/src/application/access/ports/acl-reader.port.ts` +
      `packages/server/src/infrastructure/persistence/prisma/acl-reader.adapter.ts` и
      `sql/resolve-acl.query.sql` (один round-trip).
- [ ] `packages/server/src/application/access/services/ancestor-chain.service.ts` — построение
      цепочки по типам ресурсов (`Task→Board→Project`, `File→FileFolder(path)→Project`, …).
- [ ] `packages/server/src/application/access/use-cases/grant-acl.use-case.ts`,
      `revoke-acl.use-case.ts`; массовый инкремент версий по субъекту (USER / все носители ROLE /
      все члены TEAM).
- [ ] `packages/server/src/presentation/http/routes/registry.ts` — `acl:read`, `acl:grant`, `acl:revoke`.
- [ ] Тесты: `acl-resolution.spec.ts` (12 краевых случаев §5), `implicit-level.spec.ts` (13 строк),
      интеграционные `resolve-acl-single-query.spec.ts` (счётчик SQL), `acl-list-consistency.spec.ts`
      (п. 12), isolation-тест `resource_acl`.

## Ссылки

- [`permission-model.md` §2 «Слой 4 — resource-scoped ACL»](../../../docs/security/permission-model.md)
- [`permission-model.md` §5 `implicitLevel`, краевые случаи 3, 6, 7, 9, 12](../../../docs/security/permission-model.md)
- [`permission-model.md` §6 «Наследование ACL», «Как это выполняется в БД», «Списки»](../../../docs/security/permission-model.md)
- [`permission-model.md` §12, расхождение №5](../../../docs/security/permission-model.md)
- [`threat-model.md`, `T-TENANT-05`, `T-PROJ-01`](../../../docs/security/threat-model.md)

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
