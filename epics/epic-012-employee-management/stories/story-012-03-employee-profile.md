---
id: STORY-012-03
epic: EPIC-012
status: backlog
blocked: false
priority: must
estimate: M
---

# STORY-012-03 — Профиль сотрудника и аватар

**Как** администратор системы (P5) **я хочу** вести кадровую запись сотрудника — должность, отдел,
руководителя, недельную ёмкость, навыки и аватар, **чтобы** в системе существовала оргструктура и
основание для планирования загрузки, а чувствительные поля видел только тот, кому положено.

## Acceptance (Given/When/Then)

1. **Создание и редактирование профиля.**
   Given администратор с `employee:update`;
   When `PATCH /api/v1/employees/{userId}` с `{ jobTitle, department, managerId,
   weeklyCapacityHours: 40, employmentType, hiredAt, timezone, skills: ["ts","postgres"] }`;
   Then `EmployeeProfile` обновлён (1:1 к `User`), в `AuditLog` — `employee.updated` с before/after
   без чувствительных значений.

2. **Свой профиль редактируется частично.**
   Given сотрудник без `employee:update`;
   When он меняет свои имя, аватар, `locale`, `timezone`, навыки;
   Then операция разрешена; попытка изменить `jobTitle`, `managerId`, `weeklyCapacityHours`,
   `hiredAt` даёт 403 `permission_not_granted` — кадровые поля не самообслуживаются.

3. **Негативный сценарий — чувствительные поля не отдаются.**
   Given сотрудник без `employee:view_personal_data`;
   When он читает чужой профиль;
   Then ответ **не содержит ключей** `emergencyContact`, `hiredAt`, `terminatedAt`,
   `employmentType`; фильтрация выполняется отдельным сериализатором на сервере, а не скрытием на
   клиенте (снапшот-тест ответа по ролям, аналог `T-PROJ-05`).

4. **Негативный сценарий — себестоимость не видна.**
   Given сотрудник без `employee:view_cost_rate`;
   When он читает профиль;
   Then в ответе нет ни одного ключа с префиксом `cost*`; `admin` тоже его не видит (разделение
   обязанностей по §4.1 `permission-model.md`).

5. **Экстренный контакт шифруется.**
   Given заполняется `emergencyContact`;
   When данные сохраняются;
   Then в БД лежит `emergency_contact_enc` (`APP_ENCRYPTION_KEY`, префикс версии ключа `v1:`);
   plaintext-колонки не существует, значение никогда не логируется.

6. **Оргструктура без циклов.**
   Given Иван — руководитель Петра;
   When Петра назначают руководителем Ивана;
   Then 422 `manager_cycle_detected`; проверка выполняется рекурсивным обходом до корня в той же
   транзакции; сотрудник не может быть руководителем самому себе.

7. **Аватар через файловое хранилище.**
   Given пользователь загружает аватар;
   When выполняется presigned-upload и `commit`;
   Then создаётся `File(scope = PERSONAL, ownerId = userId)`, размер ≤ 2 МБ, MIME ∈
   `{image/png, image/jpeg, image/webp}` по whitelist; ссылка на аватар отдаётся как presigned GET
   с коротким TTL (интеграция с [EPIC-015](../../epic-015-file-storage/epic.md)).

8. **Негативный сценарий — SVG-аватар.**
   Given загружается `image/svg+xml` или файл с подменённым расширением;
   When выполняется `commit`;
   Then 415 `unsupported_media_type`: тип определяется по фактическому ответу `HeadObject`, а не по
   заявленному клиентом (`T-FILE-06`).

9. **Ёмкость валидируется.**
   Given `weeklyCapacityHours = 200` или отрицательное значение;
   When приходит запрос;
   Then 422; допустимый диапазон 0…80 задан Zod-схемой и продублирован `CHECK` в БД.

10. **Кросс-тенантность.**
    Given `userId` из организации B;
    When администратор организации A читает или меняет профиль;
    Then **404** `resource_not_found`.

## Задачи

- [ ] `packages/server/prisma/migrations/*_employee_profiles/migration.sql` — таблица
      `employee_profiles` (`user_id @unique`, `job_title`, `department`, `manager_id`,
      `weekly_capacity_hours` + CHECK 0…80, `employment_type`, `hired_at`, `terminated_at`,
      `timezone`, `skills text[]`, `emergency_contact_enc`), индексы
      `idx_employee_profiles_org_manager`, частичный `... WHERE terminated_at IS NULL`,
      RLS `ENABLE` + `FORCE` + политики.
- [ ] `packages/server/src/application/iam/use-cases/update-employee-profile.use-case.ts`,
      `update-own-profile.use-case.ts`.
- [ ] `packages/server/src/domain/iam/access/employee-access.policy.ts` — разделение «своё vs чужое»,
      whitelist самообслуживаемых полей.
- [ ] `packages/server/src/domain/iam/org-chart.ts` — чистая функция `assertNoManagerCycle`.
- [ ] `packages/server/src/presentation/http/serializers/employee.serializer.ts` — три уровня
      (публичный / кадровый / финансовый) по правам.
- [ ] `packages/server/src/infrastructure/crypto/field-encryption.adapter.ts` — использование для
      `emergencyContactEnc`.
- [ ] `packages/client/src/units/employee/{model/validation,service,ui}` — схема профиля,
      хуки, компоненты; `widgets/employee-profile-form/employee-profile-form.widget.tsx`;
      `shared/ui/avatar-uploader.component.tsx`.
- [ ] Тесты: `employee-access.policy.spec.ts`, `org-chart.spec.ts` (циклы), снапшот-тест
      сериализаторов по ролям (п. 3, 4), интеграционный на п. 5, 8, 10, isolation-тест
      `employee_profiles`.

## Ссылки

- [`data-model.md`, группа 1, «Почему `User` и `EmployeeProfile` разделены»](../../../docs/architecture/data-model.md)
- [`permission-model.md` §3.2, §4.1 (кто видит `employee:view_cost_rate`)](../../../docs/security/permission-model.md)
- [`threat-model.md`, «Приватность и ПДн», `T-FILE-06`, `T-PROJ-05`](../../../docs/security/threat-model.md)
- [`ux-architecture.md`, `/admin/members/$userId`, «Формы»](../../../docs/architecture/ux-architecture.md)

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
