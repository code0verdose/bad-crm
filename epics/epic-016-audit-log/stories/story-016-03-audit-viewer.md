---
id: STORY-016-03
epic: EPIC-016
status: backlog
blocked: false
priority: must
estimate: M
---

# STORY-016-03 — Просмотр и фильтрация журнала

**Как** администратор системы (P5) **я хочу** искать в журнале по актору, действию, объекту и
периоду и открывать карточку события с состоянием до и после, **чтобы** разбор инцидента занимал
минуты и заканчивался ссылкой, которую можно отправить владельцу.

## Acceptance (Given/When/Then)

1. **Состояние фильтров в URL.**
   Given экран `/admin/audit`;
   When администратор задаёт фильтры;
   Then URL содержит `?q=&actor[]=u1&action[]=role.assigned&resource[]=USER_ROLE&from=2026-07-01&to=2026-07-26&cursor=`;
   схема `auditSearchSchema` (Zod + `zodValidator` + `z.coerce` для дат) валидирует и отбрасывает
   мусор; перезагрузка и «назад» восстанавливают экран точно.

2. **Keyset-пагинация.**
   Given журнал за год;
   When пользователь листает;
   Then используется курсорная пагинация по `(occurred_at DESC, id DESC)`, а не `OFFSET`; страницы
   стабильны при поступлении новых записей.

3. **Карточка события.**
   Given запись с `before`/`after`;
   When она открыта;
   Then показан читаемый diff (для наборов прав — «добавлено / убрано» поверх полных списков),
   актор, `actorType`, время в таймзоне пользователя, `requestId`, `resourceType`/`resourceId` со
   ссылкой на объект (если он ещё существует).

4. **Разграничение доступа.**
   Given три пользователя: с `audit:read`, с `audit:read` + `audit:read_security`, без прав;
   When они открывают журнал;
   Then первый видит общий журнал **без** событий безопасности (права, vault, impersonation,
   escrow); второй — всё; третий получает 403 и не видит пункта меню.

5. **Негативный сценарий — утечка через `before`/`after`.**
   Given событие, содержащее поля, недоступные читателю (например, финансовые);
   When оно отображается пользователю с `audit:read`, но без соответствующего права;
   Then чувствительные ключи отфильтрованы серверным сериализатором (снапшот-тест по ролям), а не
   скрыты на клиенте.

6. **Негативный сценарий — попытка изменить запись.**
   Given интерфейс журнала;
   When проверяется API;
   Then эндпоинтов `PATCH`/`DELETE` для `audit_logs` не существует вовсе; их отсутствие
   зафиксировано в `ROUTE_REGISTRY` и в `permission-matrix`.

7. **Производительность.**
   Given годовой объём организации на 50 человек;
   When выполняется фильтрация по периоду и актору;
   Then p95 < 300 мс: запрос попадает в нужные партиции (pruning) и покрывается
   `idx_audit_logs_actor`; тест на число SQL-запросов исключает N+1 при подстановке имён акторов.

8. **История объекта.**
   Given карточка роли, пользователя или файла;
   When открыта вкладка «История»;
   Then показаны события именно по этому `resourceId` (индекс `idx_audit_logs_resource`), с теми же
   правилами доступа.

9. **Кросс-тенантность.**
   Given записи организаций A и B;
   When администратор A фильтрует журнал;
   Then в выдаче нет ни одной строки B (RLS + isolation-тест).

10. **Состояния экрана.**
    Given загрузка, отсутствие результатов и ошибка;
    When они происходят;
    Then первичная загрузка — skeleton; пустой результат объясняет, какие фильтры сузили выдачу, и
    предлагает сбросить; ошибка — inline error-state с retry (не тост).

11. **a11y и i18n.**
    Given таблица журнала;
    When она проверяется axe и с клавиатуры;
    Then 0 нарушений A/AA, `severity` читается не только цветом (иконка + текст), даты
    форматируются локале-зависимо, названия действий берутся из i18n-словаря EN и RU (ключ
    `audit.action.<action>`), а не собираются конкатенацией.

## Задачи

- [ ] `packages/server/src/application/platform/queries/list-audit-events.query.ts` — keyset,
      фильтры, разделение по `audit:read_security`.
- [ ] `packages/server/src/application/platform/queries/get-audit-event.query.ts`,
      `list-resource-history.query.ts`.
- [ ] `packages/server/src/presentation/http/serializers/audit-event.serializer.ts` — фильтрация
      полей `before`/`after` по правам читателя.
- [ ] `packages/server/src/presentation/http/routes/registry.ts` — `audit:read`,
      `audit:read_security` (только `GET`-маршруты; изменяющих не существует).
- [ ] `packages/client/src/app/routes/_authenticated/admin/audit.tsx` —
      `validateSearch: zodValidator(auditSearchSchema)`, `beforeLoad: requirePermission('audit:read')`.
- [ ] `packages/client/src/units/audit/model/validation/audit-search.schema.ts`,
      `model/enums/audit-action.enums.ts` (union + label-map EN/RU).
- [ ] `packages/client/src/units/audit/service/hooks/use-audit-filters.hook.ts`,
      `use-audit-list.hook.ts` (`useInfiniteQuery` + `keepPreviousData` + `signal`).
- [ ] `packages/client/src/widgets/audit-log/audit-log.widget.tsx` +
      `ui/audit-filters-bar.component.tsx`, `ui/audit-table.component.tsx`,
      `ui/audit-event-drawer.component.tsx`, `ui/audit-diff.component.tsx`,
      `ui/audit-empty-state.component.tsx`.
- [ ] i18n: `packages/client/src/app/i18n/{en,ru}/audit.json`.
- [ ] Тесты: `use-audit-filters.hook.spec.ts`, `list-audit-events.query.spec.ts` (п. 2, 7),
      снапшот сериализатора по ролям (п. 4, 5), e2e `admin-audit.spec.ts` (п. 1, 10) + axe.

## Ссылки

- [`ux-architecture.md`, `/admin/audit`, «Списки и фильтры», «Таблицы»](../../../docs/architecture/ux-architecture.md)
- [`permission-model.md` §10 «Кто может смотреть» (`audit:read`, `audit:read_security`)](../../../docs/security/permission-model.md)
- [`data-model.md`, группа 14, индексы аудита](../../../docs/architecture/data-model.md)
- [`threat-model.md`, `T-PLAT-05`, `T-PLAT-06`](../../../docs/security/threat-model.md)
- PRD: NFR-2, персона P5

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
