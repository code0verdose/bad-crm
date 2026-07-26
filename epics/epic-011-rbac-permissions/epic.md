---
id: EPIC-011
title: Роли, права и ACL
status: backlog
blocked: false
milestone: M2
owner: unassigned
created: 2026-07-26
---

# EPIC-011 — Роли, права и ACL

## Зачем (ценность)

Пункт 3 ТЗ — «управление ролями и доступами, **в том числе кастомно по каждому юзеру**» — это не
одна функция, а сквозная зависимость всех остальных доменов. Каждый эпик после M2 (задачи,
документы, файлы, чат, время, vault, финансы) спрашивает у этого слоя «можно ли?». Если модель прав
появится позже доменов, её придётся ретрофитить в готовый продукт — то есть переписывать.

Эпик реализует пятислойную модель из [`permission-model.md`](../../docs/security/permission-model.md):
закрытый каталог permissions в коде, системные и кастомные роли, **персональные исключения по
каждому пользователю** (это и есть буквальное требование ТЗ), ACL на конкретный ресурс с
наследованием — и **ровно одно место в коде, где принимается решение о доступе**. Последнее —
прямая митигация риска [R-15](../../docs/product/prd.md#реестр-рисков) («модель прав ломается под
кастомными override») и угроз `T-TENANT-05` (IDOR внутри организации) и `T-IAM-09` (эскалация через
выдачу ролей) из [`threat-model.md`](../../docs/security/threat-model.md), обе входят в топ-15
приоритетных угроз со сроком M2.

Для владельца инсталляции (P1) и администратора (P5) это означает: онбординг и офбординг — операции
с доказуемым следом; исключение «этому одному человеку нельзя выставлять счета» не порождает
сороковую роль; на вопрос «почему у него есть доступ» есть экран с ответом, а не чтение кода.

## Scope

### В скоупе

- **Слой 1.** Каталог `PERMISSIONS` + `PERMISSION_META` в `packages/shared`, сид справочника
  `Permission` (с `deprecatedAt`), правила именования и CI-проверка формата ключа.
- **Слой 2.** `Role`, `RolePermission` (только ALLOW), системные роли `owner`/`admin`/`manager`/
  `lead`/`developer`/`viewer`/`guest` из `SYSTEM_ROLE_PERMISSIONS`, кастомные роли организации.
- **Слой 3.** `UserRole` с `expiresAt`; `UserPermissionOverride` (ALLOW/DENY, обязательный `reason`,
  `expiresAt`) — персональные исключения по каждому пользователю.
- **Слой 4.** `ResourceAcl` с упорядоченной шкалой `NONE < VIEWER < COMMENTER < EDITOR < MANAGER`,
  цепочки наследования, `implicitLevel`, субъекты `USER | ROLE | TEAM`.
- **Слой 5.** `domain/<context>/access/*.policy.ts` c `Decision { allowed, reason }`,
  `*-access-reader.port.ts`, `EffectivePermissionsService` + кеш Redis по `permissionsVersion`,
  `requirePermission` как fail-fast middleware, `GET /api/v1/me/permissions`.
- **Клиент.** `useCan()`, `<Can>`, гарды `beforeLoad`, признаки `permissions` в DTO ресурсов.
- **Проверяемость.** `permission-matrix` snapshot-тест на реальном HTTP-стеке, CI-правило «нет
  маршрута без объявленной permission», табличные тесты policy по таблице истинности.
- **UI администратора.** Матрица ролей с batch-применением и предпросмотром «кого затронет»; экран
  персональных исключений с тремя состояниями (ALLOW / DENY / наследовано); экран объяснения
  доступа (`permission:explain`).
- **Аудит.** Каждое изменение ролей, прав и ACL — запись `AuditLog` в той же транзакции.

### Вне скоупа

- **Аутентификация** (пароли, сессии, refresh, TOTP) — [EPIC-006](../epic-006-auth-core/epic.md) и
  [EPIC-013](../epic-013-two-factor-totp/epic.md).
- **RLS и изоляция арендаторов** — [EPIC-005](../epic-005-multi-tenancy-rls/epic.md); RLS отвечает
  на вопрос «чья это строка», а не «что этому человеку можно» (см. §11 `permission-model.md`).
- **Доменные policy конкретных сущностей задач и досок** — [EPIC-021](../epic-021-task-access-control/epic.md);
  здесь строится механизм и эталонная policy для проекта и файла.
- **Делегирование прав, `AccessRequest` («запросить доступ»), scoped-токены API, break-glass,
  массовая правка ACL, ABAC-условия** — открытые вопросы §12 `permission-model.md`, вынесены за M2.
- **Группы как отдельный `subjectType = GROUP`** — субъектами остаются `USER`, `ROLE`, `TEAM`.
- Изменение состава системных ролей из UI — запрещено по построению.

## Acceptance (эпик выполнен, когда)

- [ ] Каталог permissions существует в единственном экземпляре в `packages/shared`; сервер и клиент
      импортируют один и тот же тип `PermissionKey`; ключ вне каталога не компилируется.
- [ ] Справочник `Permission` в БД синхронизирован с кодом сидом в транзакции миграции; пропавший из
      кода ключ помечается `deprecatedAt`, а не удаляется.
- [ ] Семь системных ролей создаются в каждой новой организации; их состав прав совпадает с §4
      `permission-model.md` и не редактируется из UI.
- [ ] Организация может создать кастомную роль из существующих ключей каталога и назначить её людям.
- [ ] Персональное исключение (ALLOW и DENY) с обязательным `reason` и `expiresAt` работает поверх
      ролей; DENY побеждает всё, кроме владельца.
- [ ] ACL на ресурс работает с наследованием: «ближайшая явная запись побеждает», `NONE` на узле —
      явный запрет, отсутствие записей — `implicitLevel`.
- [ ] Решение о доступе вычисляется **ровно в одном месте** (`can()` из `packages/shared` +
      policy-обёртка); второй точки вычисления нет — проверяется агентом и архитектурным тестом (R-15).
- [ ] Таблица истинности §5 `permission-model.md` (16 строк) и 12 краевых случаев покрыты
      табличными тестами policy на 100 % строк и ветвей.
- [ ] `permission-matrix` snapshot-тест зелёный, гоняется на реальном HTTP-стеке, любое расширение
      прав видно в диффе с пометкой `⚠ расширение прав`.
- [ ] Ни один зарегистрированный маршрут не существует без `permission` или без `public: true` с
      непустым `publicReason`; маршрут с `:id` обязан объявить `aclCheckedIn`.
- [ ] Изменение прав отражается на следующем запросе без перелогина (инвалидация по
      `permissionsVersion`); Redis недоступен — система работает корректно, но медленнее.
- [ ] Кросс-тенантный запрос к объекту чужой организации даёт **404**, а не 403 и не пустой 200.
- [ ] Администратор видит матрицу ролей, применяет пачку изменений с предпросмотром «кого затронет»,
      выставляет персональные исключения и получает ответ на вопрос «почему у него есть доступ».
- [ ] Каждое изменение роли, назначения, исключения и ACL — запись `AuditLog` с полным набором прав
      до и после, в той же транзакции.

## Зависимости / риски

- **Зависит от:** [EPIC-003](../epic-003-server-skeleton-and-api-contract/epic.md) (гексагональные
  слои, `problem+json`, реестр маршрутов), [EPIC-004](../epic-004-client-shell-fsd/epic.md) (FSD,
  TanStack Router/Query), [EPIC-005](../epic-005-multi-tenancy-rls/epic.md) (RLS, tenant-контекст,
  `withTenant`), [EPIC-006](../epic-006-auth-core/epic.md) (`Actor` из сессии, `permissionsVersion`
  в access-токене), [EPIC-002](../epic-002-ci-and-commit-gate/epic.md) (гейт, куда встраивается
  `permission-matrix-auditor`).
- **Блокирует:** [EPIC-012](../epic-012-employee-management/epic.md),
  [EPIC-014](../epic-014-project-core/epic.md), [EPIC-015](../epic-015-file-storage/epic.md),
  [EPIC-016](../epic-016-audit-log/epic.md) и весь M3–M9 — каждый домен проверяет права этим слоем.
- **Риски:**
  - `R-15` — комбинации override × ACL становятся неочевидными. Митигация: единый детерминированный
    алгоритм, таблица истинности в тестах, экран объяснения, запрет второй точки вычисления.
  - `T-IAM-09` — эскалация через выдачу ролей. Митигация: нельзя выдать capability, которой нет у
    выдающего; запрет самоназначения; `self_lockout`; `last_owner_required`; всё в `AuditLog`.
  - `T-TENANT-05` — IDOR внутри организации: policy забыта на одном из десятков вложенных маршрутов.
    Митигация: реестр маршрутов + `permission-matrix` + `aclCheckedIn`.
  - Производительность списков: построчный `can()` на 200 задач = 200 резолвов ACL. Митигация —
    множество доступных родителей одним запросом (§6 `permission-model.md`) + тест согласованности
    «список = фильтр по `can()` построчно».
  - Расхождение документа и кода: §4 матрица ролей живёт и в документе, и в
    `SYSTEM_ROLE_PERMISSIONS`. Митигация — снапшот-тест и агент `permission-matrix-auditor`.

## Ссылки

- [`docs/security/permission-model.md`](../../docs/security/permission-model.md) — источник правды
  (§1 слои, §3 каталог, §4 системные роли, §5 алгоритм и таблица истинности, §6 наследование,
  §7 реализация по слоям, §8 кеш, §9 тесты, §10 аудит, §11 соотношение с RLS).
- [`docs/security/rls-design.md`](../../docs/security/rls-design.md) — чек-лист новой таблицы,
  обвязка isolation-тестов.
- [`docs/security/threat-model.md`](../../docs/security/threat-model.md) — `T-IAM-09`,
  `T-TENANT-05`, `T-PROJ-02`, топ-15.
- [`docs/architecture/data-model.md`](../../docs/architecture/data-model.md) — группа 2 «Права и доступ».
- [`docs/architecture/ux-architecture.md`](../../docs/architecture/ux-architecture.md) — `/admin/roles`,
  «Права в интерфейсе», «403 vs 404», «Гарды в `beforeLoad`».
- [`docs/product/prd.md`](../../docs/product/prd.md) — риск `R-15`, NFR-6.

## Истории

- [ ] [STORY-011-01 — Каталог permissions и синхронизация справочника](stories/story-011-01-permissions-catalog.md)
- [ ] [STORY-011-02 — Системные роли и матрица прав](stories/story-011-02-system-roles.md)
- [ ] [STORY-011-03 — Кастомные роли организации](stories/story-011-03-custom-roles.md)
- [ ] [STORY-011-04 — Назначение и отзыв ролей](stories/story-011-04-role-assignment.md)
- [ ] [STORY-011-05 — Персональные исключения прав по пользователю](stories/story-011-05-user-permission-overrides.md)
- [ ] [STORY-011-06 — ACL на ресурс и наследование по цепочке](stories/story-011-06-resource-acl.md)
- [ ] [STORY-011-07 — Policy-слой, порты доступа и реестр маршрутов](stories/story-011-07-policy-layer.md)
- [ ] [STORY-011-08 — Эффективные права, кеш и `GET /me/permissions`](stories/story-011-08-effective-permissions.md)
- [ ] [STORY-011-09 — permission-matrix snapshot test и CI-гейт каталога](stories/story-011-09-permission-matrix-test.md)
- [ ] [STORY-011-10 — Админ-UI: матрица ролей с batch-применением](stories/story-011-10-admin-role-matrix-ui.md)
- [ ] [STORY-011-11 — Админ-UI: персональные исключения и объяснение доступа](stories/story-011-11-admin-overrides-ui.md)
