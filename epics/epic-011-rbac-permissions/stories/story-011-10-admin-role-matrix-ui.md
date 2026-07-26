---
id: STORY-011-10
epic: EPIC-011
status: backlog
blocked: false
priority: must
estimate: L
---

# STORY-011-10 — Админ-UI: матрица ролей с batch-применением

**Как** администратор системы (P5) **я хочу** видеть на одном экране, какая роль что может, и
менять состав прав пачкой — с предпросмотром «кого это затронет» перед сохранением, **чтобы**
понимать модель доступов без чтения документации и не раздавать лишние права по одному неверному
клику.

## Acceptance (Given/When/Then)

1. **Матрица читается и фильтруется из URL.**
   Given экран `/admin/roles`;
   When пользователь ищет `invoice`, сворачивает группы и включает «только различия»;
   Then состояние живёт в query-параметрах (`?q=invoice&group[]=delivery&diff=1&role=manager`),
   переживает перезагрузку, работает с кнопкой «назад»; схема — `rolesSearchSchema` (Zod,
   `validateSearch`), мусорные значения отбрасываются схемой.

2. **Строки — права по доменам, колонки — роли.**
   Given 307 прав и 7 системных + N кастомных ролей;
   When экран отрисован;
   Then первый столбец и шапка «прилипшие», группы соответствуют доменам каталога, опасные права
   визуально помечены, deprecated — серым с плашкой «выведено из употребления».

3. **Ячейка роли бинарна.**
   Given ячейка (право × роль);
   When пользователь кликает;
   Then состояние переключается «входит / не входит» — трёхсостоятельности здесь нет, она
   существует только на экране персональных исключений (расхождение №3 §12 `permission-model.md`).

4. **Изменения копятся в черновике.**
   Given пользователь переключил 12 ячеек;
   When он не нажал «Сохранить»;
   Then ни одного запроса к серверу не отправлено (оптимистично только локальное состояние), внизу
   панель «12 изменений» с кнопками «Сохранить» и «Отменить»; черновик в URL не пишется.

5. **Предпросмотр «кого затронет».**
   Given черновик с изменениями;
   When нажата «Сохранить»;
   Then показывается сводка: по каждой роли — что добавлено/убрано и **число носителей**, а для
   опасных прав — отдельное предупреждение; применение требует подтверждения; серверный расчёт
   приходит из `POST /api/v1/roles/preview-changes` (read-only, право `role:read`).

6. **Применение — одна пессимистичная операция.**
   Given подтверждённый черновик;
   When он сохраняется;
   Then выполняется один batch-запрос в одной транзакции; при успехе — зелёный тост и
   инвалидация ключей `QueryKeys.Iam.roles`; частичного применения не бывает.

7. **Негативный сценарий — самоблокировка.**
   Given администратор снимает право `role:update` с роли, которая является его единственным
   источником этого права;
   When он кликает по ячейке;
   Then переключатель заблокирован с объяснением в тултипе; при обходе UI сервер отвечает 409
   `self_lockout`, черновик не теряется.

8. **Негативный сценарий — системная роль только для чтения.**
   Given колонка `admin` (`isSystem = true`);
   When пользователь пытается изменить ячейку;
   Then ячейка неактивна, у колонки виден замок с пояснением «состав системной роли задаётся кодом;
   нужно иначе — кастомная роль или персональное исключение».

9. **Негативный сценарий — нет права на экран.**
   Given пользователь без `role:read`;
   When он открывает `/admin/roles` по прямой ссылке;
   Then гард `beforeLoad` редиректит на экран 403 до рендера; кнопка входа в раздел в навигации
   отсутствует.

10. **Ошибка сохранения не теряет работу.**
    Given сервер вернул 409 на часть изменений;
    When приходит ответ;
    Then над панелью — inline-баннер с перечнем непринятых изменений, черновик сохранён, тост
    ошибки один (глобальный `MutationCache.onError` не дублируется локальным).

11. **Уход со страницы с несохранённым.**
    Given непустой черновик;
    When пользователь уходит с маршрута;
    Then срабатывает dirty-guard с подтверждением.

12. **a11y и i18n.**
    Given матрица;
    When она проверяется axe и с клавиатуры;
    Then 0 нарушений A/AA, полная навигация стрелками по ячейкам (роль `grid`), видимый фокус,
    все строки — из i18n-ключей EN и RU, ни одной хардкод-строки.

## Задачи

- [ ] `packages/client/src/app/routes/_authenticated/admin/roles/index.tsx` — тонкий route:
      `validateSearch: zodValidator(rolesSearchSchema)`, `beforeLoad: requirePermission('role:read')`,
      `loader: ensureQueryData(rolesMatrixQueryOptions)`.
- [ ] `packages/client/src/pages/admin-roles/page.tsx` + `ui/` — композиция без логики.
- [ ] `packages/client/src/widgets/role-matrix/role-matrix.widget.tsx` и
      `ui/role-matrix-cell.component.tsx`, `role-matrix-group.component.tsx`,
      `role-matrix-draft-bar.component.tsx`, `role-matrix-preview-modal.component.tsx` (по одному
      компоненту на файл).
- [ ] `packages/client/src/units/iam/model/validation/roles-search.schema.ts`,
      `model/enums/permission-domain.enums.ts` (label-map EN/RU).
- [ ] `packages/client/src/units/iam/service/queries/roles-matrix.query.ts`,
      `service/mutations/apply-role-changes.mutation.ts`,
      `service/hooks/use-role-matrix-draft.hook.ts` (черновик, dirty-guard, вычисление diff).
- [ ] `packages/server/src/application/iam/queries/preview-role-changes.query.ts` +
      `use-cases/apply-role-changes.use-case.ts` (batch в одной транзакции).
- [ ] i18n: `packages/client/src/app/i18n/{en,ru}/admin-roles.json`.
- [ ] Тесты: `use-role-matrix-draft.hook.spec.ts`, компонентные (Testing Library) на п. 3, 7, 8, 10,
      e2e `admin-role-matrix.spec.ts` (п. 1, 5, 6, 11) + axe.

## Ссылки

- [`ux-architecture.md`, «Управление ролями и правами (`/admin/roles`) — матрица»](../../../docs/architecture/ux-architecture.md)
- [`ux-architecture.md`, «Списки и фильтры», «Подтверждение разрушающих действий», «Гарды в beforeLoad»](../../../docs/architecture/ux-architecture.md)
- [`permission-model.md` §4.11, §12 расхождение №3](../../../docs/security/permission-model.md)
- [`threat-model.md`, `T-IAM-09`](../../../docs/security/threat-model.md)

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
