---
id: STORY-011-11
epic: EPIC-011
status: backlog
blocked: false
priority: must
estimate: L
---

# STORY-011-11 — Админ-UI: персональные исключения и объяснение доступа

**Как** администратор системы (P5) **я хочу** на карточке сотрудника видеть все его права с
источником каждого и точечно переключать отдельные права в «разрешено» / «запрещено» /
«наследовано», а также получать ответ на вопрос «почему у него есть этот доступ», **чтобы**
исключения были обозримы и объяснимы, а не превращались в вечную загадку через полгода.

## Acceptance (Given/When/Then)

1. **Три состояния на право.**
   Given вкладка `/admin/members/{userId}?tab=roles`;
   When экран отрисован;
   Then каждое право показано в одном из трёх состояний: **ALLOW** (персональное разрешение),
   **DENY** (персональный запрет), **наследовано** (из ролей — с указанием, какая роль дала, или
   «не выдано»); фактический итог подсвечен отдельно от источника.

2. **Создание исключения требует причины и срока.**
   Given администратор переключает право в DENY;
   When открывается форма;
   Then обязательны `reason` (≥ 10 символов после `trim`, inline-ошибка поля, не тост) и
   `expiresAt`; для ALLOW поле предзаполнено «+30 дней», «бессрочно» требует явного снятия галочки.

3. **Возврат к наследованию.**
   Given у пользователя есть исключение;
   When администратор выбирает «наследовано»;
   Then строка `UserPermissionOverride` удаляется, право снова определяется ролями; в `AuditLog` —
   `permission.override.deleted` с `before`.

4. **Причина видна рядом с исключением.**
   Given исключение с `reason` и `grantedById`;
   When пользователь наводит на бейдж;
   Then показываются причина, кто выдал, когда и до какого числа.

5. **Экран объяснения доступа.**
   Given право `project:update` и конкретный ресурс;
   When администратор с `permission:explain` открывает «Почему есть доступ»;
   Then показывается цепочка решения: capability (какая роль дала / какой оверрайд перебил) → узел
   ACL, который сработал, с записью `ResourceAcl` (`grantedById`, `accessLevel`, `expiresAt`) →
   итоговое `Decision` с `DenyReason` при отказе. Данные приходят из
   `GET /api/v1/permissions/explain?userId&key&resourceId`, который использует **тот же** `can()`,
   а не собственную копию логики.

6. **Негативный сценарий — DENY на владельца.**
   Given целевой пользователь — владелец организации;
   When администратор пытается выставить DENY;
   Then переключатель заблокирован с пояснением; при обходе UI сервер отвечает 409 `owner_immutable`.

7. **Негативный сценарий — самоблокировка.**
   Given администратор открыл собственную карточку;
   When он выставляет себе DENY на `permission:override` или `role:update`;
   Then 409 `self_lockout`, состояние в UI откатывается, показан один тост ошибки.

8. **Негативный сценарий — выдать больше, чем есть у себя.**
   Given администратор без `vault_item:export`;
   When он выдаёт ALLOW на `vault_item:export`;
   Then 403 `permission_not_granted` с человекочитаемым текстом «нельзя выдать право, которого нет
   у вас»; строка не создана.

9. **Негативный сценарий — нет права на экран.**
   Given пользователь без `permission:override_read`;
   When он открывает вкладку;
   Then вкладка отсутствует в навигации, прямой переход даёт экран 403 (гард в `beforeLoad`);
   для `explain` требуется `permission:explain`.

10. **Опасные права подтверждаются отдельно.**
    Given выдаётся ALLOW на право с `dangerous: true`;
    When пользователь нажимает «Применить»;
    Then модалка подтверждения с явным перечислением последствий; действие пишется в `AuditLog` с
    повышенной `severity`.

11. **Список исключений организации.**
    Given администратор хочет ревизию;
    When он открывает фильтр «только исключения» на `/admin/members`;
    Then список фильтруется по наличию активных оверрайдов (состояние в URL), видны ключ, эффект,
    причина и срок; истёкшие показаны отдельно.

12. **a11y и i18n.**
    Given экран исключений и экран объяснения;
    When они проверяются axe и с клавиатуры;
    Then 0 нарушений A/AA, переключатель трёх состояний доступен с клавиатуры и объявляется
    скринридером (`aria-checked="mixed"` для «наследовано»), все строки — из i18n EN и RU.

## Задачи

- [ ] `packages/client/src/app/routes/_authenticated/admin/members/$userId.tsx` — вкладка `roles`,
      `beforeLoad: requirePermission('user:read')`, вложенный гард на `permission:override_read`.
- [ ] `packages/client/src/widgets/user-permissions/user-permissions.widget.tsx` +
      `ui/permission-tri-state-toggle.component.tsx`, `ui/override-reason-form.component.tsx`,
      `ui/permission-source-badge.component.tsx` (один компонент на файл).
- [ ] `packages/client/src/widgets/permission-explain/permission-explain.widget.tsx` +
      `ui/explain-chain.component.tsx`.
- [ ] `packages/client/src/units/iam/service/hooks/use-user-permissions.hook.ts`,
      `service/queries/user-permissions.query.ts`, `permission-explain.query.ts`,
      `service/mutations/upsert-permission-override.mutation.ts`,
      `delete-permission-override.mutation.ts` (оптимистичный патч + rollback из
      `shared/api/optimistic.ts`).
- [ ] `packages/client/src/units/iam/model/validation/permission-override.schema.ts` (Zod, `reason`
      ≥ 10, `expiresAt`), резолвер `mantine-form-zod-resolver`.
- [ ] `packages/server/src/application/access/queries/explain-permission.query.ts` +
      маршрут `GET /permissions/explain` с `permission:explain` в `ROUTE_REGISTRY`.
- [ ] i18n: `packages/client/src/app/i18n/{en,ru}/admin-permissions.json`.
- [ ] Тесты: `use-user-permissions.hook.spec.ts`, компонентные на п. 1, 2, 6, 7,
      `explain-permission.query.spec.ts` (совпадение с решением `can()` на всех 16 строках таблицы
      истинности), e2e `admin-user-overrides.spec.ts` + axe.

## Ссылки

- [`permission-model.md` §2 «Слой 3 — per-user overrides»](../../../docs/security/permission-model.md)
- [`permission-model.md` §10 «Кто может смотреть», экран объяснения (`permission:explain`)](../../../docs/security/permission-model.md)
- [`permission-model.md` §12, расхождение №3 (трёхсостоятельность — только здесь)](../../../docs/security/permission-model.md)
- [`ux-architecture.md`, «Права в интерфейсе», «Формы», «Скрывать или показывать disabled»](../../../docs/architecture/ux-architecture.md)
- PRD: риск `R-15` («UI „почему у пользователя есть этот доступ“»)

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
