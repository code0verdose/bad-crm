---
id: STORY-012-05
epic: EPIC-012
status: backlog
blocked: false
priority: must
estimate: L
---

# STORY-012-05 — Деактивация и офбординг одной операцией

**Как** администратор системы (P5) **я хочу** отключить уходящего сотрудника одной операцией и
получить отчёт о том, что именно было отозвано, **чтобы** офбординг был доказуемо полным, а не
«кажется, всё отключили».

## Acceptance (Given/When/Then)

1. **Одна операция закрывает всё.**
   Given активный сотрудник с 2 сессиями, открытым WS-соединением, ролями, членством в 3 проектах,
   2 командах и 4 созданными активными секретными ссылками;
   When `POST /api/v1/users/{userId}/deactivate` с `{ reason }` (право `user:suspend`);
   Then **в одной транзакции**: `User.status = SUSPENDED`, `EmployeeProfile.terminatedAt = now`,
   `permissions_version += 1`, все `Session` получают `revokedAt` и `revokedReason = 'offboarding'`,
   `ProjectMember.leftAt = now`, `TeamMember` удалены, `UserRole` сохранены-но-неактивны (учётка
   неактивна целиком); после коммита — разрыв WS-соединений пользователя и отзыв его активных
   `SecureLink`; ответ 200 с отчётом.

2. **Отчёт о фактическом результате.**
   Given операция выполнена;
   When возвращается ответ;
   Then он содержит счётчики по каждому пункту (`sessionsRevoked`, `socketsClosed`,
   `projectsLeft`, `teamsLeft`, `linksRevoked`, `vaultMembershipsFlagged`) и выгружается как отчёт
   офбординга; тот же набор попадает в `AuditLog` (`user.suspended`, `severity = warning`).

3. **Доступ прекращается немедленно.**
   Given у сотрудника на руках действующий access-токен (TTL 15 минут);
   When он делает запрос после деактивации;
   Then 401: `permissionsVersion` в токене не совпадает с БД, а статус `SUSPENDED` отвергает сессию
   (митигация `T-IAM-06`); WS-соединение уже разорвано, новые подписки не устанавливаются.

4. **Данные не удаляются.**
   Given сотрудник был исполнителем задач, автором комментариев и записей времени;
   When он деактивирован;
   Then все ссылки целы: задачи, часы, инвойсы и `AuditLog` продолжают ссылаться на него,
   в интерфейсе он отображается с пометкой «деактивирован» (NFR-12).

5. **Негативный сценарий — последний владелец.**
   Given деактивируется единственный владелец организации;
   When операция выполняется;
   Then 409 `last_owner_required`; ничего не изменено; UI предлагает сначала передать владение
   ([STORY-012-06](story-012-06-transfer-ownership.md)).

6. **Негативный сценарий — деактивация себя.**
   Given администратор деактивирует собственный аккаунт;
   When операция выполняется;
   Then 409 `self_lockout`.

7. **Реактивация.**
   Given деактивированный сотрудник вернулся;
   When `POST /api/v1/users/{userId}/reactivate` (право `user:reactivate`);
   Then `status = ACTIVE`, `terminatedAt = null`, версия инкрементится; **членства в проектах,
   командах и vault не восстанавливаются автоматически** — это явное решение, о котором UI
   предупреждает; в `AuditLog` — `user.reactivated`.

8. **Vault честен относительно своей природы.**
   Given сотрудник состоял в общих хранилищах;
   When он деактивирован;
   Then `VaultMembership` помечается к отзыву и в отчёте отдельной строкой указано, что **ротация
   ключа хранилища требуется** (реализуется в [EPIC-035](../../epic-035-vault-sharing/epic.md), M7):
   удаление membership без ротации не отбирает уже скачанные ключи (`T-VAULT-05`, `RR-04`).

9. **Идемпотентность и частичный отказ.**
   Given деактивация уже выполнена;
   When операция повторяется;
   Then 200 без изменений и без дублей в аудите. Given внешний шаг (разрыв WS) упал;
   Then транзакция БД уже закоммичена, шаг ретраится через outbox, отчёт помечает пункт как
   `pending`, метрика `offboarding_step_failed_total` растёт с алертом.

10. **Кросс-тенантность.**
    Given `userId` из организации B;
    When администратор организации A деактивирует его;
    Then **404** `resource_not_found`.

11. **E2E.**
    Given полный прогон `offboarding-closes-everything`;
    When сотрудник деактивирован;
    Then HTTP-запрос, WS-подписка и открытие ранее созданной им секретной ссылки — все три пути
    закрыты в одном сценарии.

## Задачи

- [ ] `packages/server/src/application/iam/use-cases/deactivate-user.use-case.ts`,
      `reactivate-user.use-case.ts` — одна транзакция + outbox-события для внешних шагов.
- [ ] `packages/server/src/domain/iam/access/user-lifecycle.policy.ts` — `assertLastOwnerKept`,
      `assertNotSelf`, `canSuspend`.
- [ ] `packages/server/src/application/iam/ports/session-revoker.port.ts`,
      `realtime-disconnector.port.ts`, `secure-link-revoker.port.ts` (последний — заглушка-порт до M7,
      с записью намерения; реализация в EPIC-036).
- [ ] `packages/server/src/application/iam/queries/build-offboarding-report.query.ts` + экспорт CSV/JSON.
- [ ] `packages/server/src/presentation/http/routes/registry.ts` — `user:suspend`, `user:reactivate`,
      `user:force_logout`.
- [ ] `packages/client/src/widgets/offboarding/offboarding-dialog.widget.tsx` — чек-лист последствий
      и подтверждение вводом фамилии; `ui/offboarding-report.component.tsx`.
- [ ] `packages/client/src/units/employee/service/mutations/deactivate-user.mutation.ts` (пессимистично).
- [ ] Тесты: `user-lifecycle.policy.spec.ts` (п. 5, 6), интеграционный `offboarding.spec.ts`
      (п. 1, 2, 7, 9, 10), `token-after-suspend.spec.ts` (п. 3),
      e2e `packages/e2e/tests/iam/offboarding-closes-everything.spec.ts` (п. 11).

## Ссылки

- [`prd.md`, персона P5 («офбординг — одна операция и один экспортируемый отчёт»), NFR-12](../../../docs/product/prd.md)
- [`threat-model.md`, `T-IAM-06`, нарушитель `N4`, `T-VAULT-05`, `RR-04`, `T-LINK-05`](../../../docs/security/threat-model.md)
- [`permission-model.md` §8 «Что инкрементит permissionsVersion», §3.2](../../../docs/security/permission-model.md)
- [`data-model.md`, группа 1, `Session`, `EmployeeProfile.terminatedAt`](../../../docs/architecture/data-model.md)

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
