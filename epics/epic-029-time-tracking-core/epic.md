---
id: EPIC-029
title: Ядро учёта времени
status: backlog
blocked: false
milestone: M6
owner: unassigned
created: 2026-07-26
---

# EPIC-029 — Ядро учёта времени

## Зачем (ценность)

Без факта «сколько времени куда ушло» не существует ни дашбордов (M6), ни бюджета и инвойсов (M9):
это единственный источник, из которого считаются деньги и загрузка. Toggl решает половину задачи —
он умеет таймер, но не знает про задачи, проекты и роли, поэтому разработчик вспоминает в пятницу,
что делал во вторник, а тимлид оценивает загрузку по ощущениям.

Эпик даёт разработчику списание времени в один клик из карточки задачи и отдельный способ честно
зафиксировать **ресерч, ревью, встречи и смежные работы** — прямое требование пункта 11 ТЗ, которое
обычно теряется, потому что «эти часы некуда записать». Технически эпик закладывает **плоскую
факт-таблицу `TimeEntry`** со звёздной схемой измерений: один скан вместо `UNION ALL` по трём
таблицам, один набор инвариантов в БД, одно место для сквозной логики (аппрувал, ставки, инвойс).

## Scope

### В скоупе

- **Плоская `TimeEntry`** (`userId`, `projectId?`, `taskId?`, `activityId`) с обязательными CHECK-ограничениями в БД, а не только в валидаторе: `task ⇒ project`, `duration_minutes <> 0`, `ended_at > started_at`.
- **`RunningTimer` с `UNIQUE(userId)`** — инвариант «один активный таймер на человека» гарантирует БД, а не UI: двойной старт из второй вкладки становится ошибкой вставки, а не двумя параллельными записями.
- Старт / стоп / переключение таймера **одной транзакцией** (`DELETE RunningTimer` + `INSERT TimeEntry`); `lastHeartbeatAt` для детекта забытых таймеров.
- Ручной ввод записи и редактирование собственных неподтверждённых записей; парсинг длительности (`1:30`, `1.5`, `90m`) Zod-схемой с `transform`.
- **Каталог активностей**: глобальный справочник `Activity` (`development`, `code-review`, `research`, `meeting`, `support`, `onboarding`, `overhead`, `pto`) + `ActivityOverride` на организацию (переименование, включение/выключение, цвет, `isBillableByDefault`).
- **Правило пересечения интервалов** — решение фиксируется ADR до реализации: мягкий режим (`TimePolicy.warnOnOverlap` — предупреждение в UI, запись сохраняется) либо жёсткий (`EXCLUDE USING gist` с `btree_gist`, вставка отклоняется). Реализуется ровно один из вариантов, оба покрыты тестами.
- **Автозакрытие забытых таймеров** воркером по `lastHeartbeatAt` и политике: запись создаётся с пометкой `needsReview`, пользователь получает уведомление и обязан подтвердить или исправить длительность.
- **Виджет таймера в шапке AppShell** — виден на любом экране; состояние серверное, между вкладками синхронизируется через `BroadcastChannel`, при расхождении выигрывает сервер; мягкое напоминание при работе таймера дольше 8 часов.
- Список записей `/time/entries` с типизированными search-params (`from`, `to`, `project[]`, `task?`, `billable?`, `sort`, `page`), debounce и отменой запроса по `signal`.
- Индексы группы 9 `data-model.md`, включая частичные (`WHERE project_id IS NOT NULL`, `WHERE task_id IS NOT NULL`).

### Вне скоупа

- Недельные таймшиты, отправка и подтверждение, снапшоты ставок, сторно — [EPIC-030](../epic-030-timesheets-and-approval/epic.md).
- Преагрегаты `TimeRollupDaily` и любые дашборды — [EPIC-031](../epic-031-dashboards/epic.md).
- Инвойсы из подтверждённых часов и бюджеты — [EPIC-042](../epic-042-billing-and-budget/epic.md).
- Импорт записей из Toggl/Harvest (`source = IMPORT` заложен в модели, обработчика нет) — вне 1.0.

## Acceptance (эпик выполнен, когда)

- [ ] Время списывается тремя способами: на задачу, на проект без задачи и на нетасковую активность (`research`, `meeting`, `pto`) — каждый путь покрыт e2e-сценарием.
- [ ] Попытка вставить `TimeEntry` с `taskId` без `projectId` или с `durationMinutes = 0` **отклоняется базой данных** (тест выполняет прямой SQL мимо приложения), а не только валидатором.
- [ ] Два параллельных запроса «старт таймера» от одного пользователя дают ровно один `RunningTimer`: второй получает конфликт уникальности и внятную ошибку, а не второй таймер.
- [ ] Стоп и переключение таймера атомарны: при сбое между удалением таймера и вставкой записи не остаётся ни потерянного времени, ни осиротевшего таймера (тест с искусственным сбоем в транзакции).
- [ ] Выбранное правило пересечений формализовано в ADR и покрыто тестами обоих исходов: пересекающийся интервал либо отклоняется базой, либо сохраняется с предупреждением — поведение детерминировано и одинаково для UI, API и импорта.
- [ ] Забытый таймер (нет heartbeat дольше порога политики) закрывается воркером, запись помечается `needsReview`, пользователь уведомлён; непросмотренные записи видны отдельным фильтром.
- [ ] Каталог активностей редактируется администратором организации: выключенная активность исчезает из выбора, но **не ломает** уже существующие записи с ней.
- [ ] Виджет таймера показывает одно и то же состояние в двух вкладках; после `docker restart` сервера таймер восстанавливается из БД, а не теряется.
- [ ] `userId` записи берётся из сессии, а не из тела запроса; попытка списать время за другого без соответствующего права возвращает 403 (митигация `T-TIME-04`).
- [ ] Негативный кросс-тенантный тест на `TimeEntry`, `RunningTimer`, `ActivityOverride`: чтение и запись строки чужого `organizationId` невозможны.

## Модель данных

- Затрагиваемые сущности: `TimeEntry` [T], `RunningTimer` [T], `ActivityOverride` [T], `TimePolicy` [T] (только чтение правил ввода — управление в EPIC-030), `Activity` **[G]** (единственная глобальная таблица группы 9, RLS не применяется), `Task` [T], `Project` [T], `User` [T].
- Новые поля/таблицы — **закрыто (2026-07-26): пробелов модели нет**, всё описано в [`data-model.md`](../../docs/architecture/data-model.md), группа 9:
  - `TimeEntry.needsReview Bool` — **в модели**; блокирует включение записи в табель, пока человек не подтвердил длительность автозакрытого таймера.
  - `TimePolicy.warnOnOverlap Bool` + `TimePolicy.forbidOverlap Bool` — **в модели**; канон: по умолчанию мягкий режим (предупреждение), жёсткий `EXCLUDE USING gist` включается политикой и только тогда действует constraint.
  - `RunningTimer` — `projectId`, `activityId`, `description` присутствуют и в таблице полей, и в ER-диаграмме (*диаграмма приведена в соответствие 2026-07-26*).
- **Противоречие в источниках, требующее решения ADR:** раздел «Индексы» `data-model.md` объявляет `EXCLUDE USING gist … WHERE (ended_at IS NOT NULL AND deleted_at IS NULL AND reverses_id IS NULL)` как безусловный запрет пересечений, тогда как roadmap M6 говорит о «правилах пересечения интервалов». Жёсткий запрет и `warnOnOverlap` взаимоисключающи — выбрать один до первой миграции.
- Расширения `TimeEntry`, вводимые в EPIC-030 (`costRateSnapshotMicros`, `billRateSnapshotMicros`, `timesheetId`, `approvalStatus`, `reversesId`, `reversalReason`), объявляются в схеме сразу, но заполняются и обеспечиваются инвариантами в EPIC-030 — это следствие правила expand → migrate → contract.

## Права

- Новые ключи (из каталога [`permission-model.md` §3.11](../../docs/security/permission-model.md)): `time:track`, `time:read_own`, `time:create_own`, `time:update_own`, `time:delete_own`, `time:read_team`, `time:read_all`, `time:update_any`, `time:delete_any`, `time:override`, `time:export`.
- **Закрыто (2026-07-26):** `time:manage_activities` **уже в каталоге** ([`permission-model.md`](../../docs/security/permission-model.md) §3: ресурс `time`, действие `manage_activities`, ACL `—`, не опасное, домен `time`). `time:manage_policy` остаётся строго про `TimePolicy` и для справочника активностей не используется.
- Требуемые ACL-уровни: `time:read_team` — `VIEWER` на проект; `time:update_any` / `time:delete_any` — `EDITOR` на проект; `time:export` — `VIEWER`. Организационные ключи (`time:track`, `*_own`, `time:read_all`, `time:override`) не привязаны к ресурсу.
- Опасные (`isDangerous`): `time:read_all`, `time:update_any`, `time:delete_any`, `time:override` — подтверждение в UI и повышенная `severity` в `AuditLog`.
- Списание на проект, участником которого пользователь не является, запрещено даже при наличии `time:create_own` (митигация `T-TIME-03`).

## Зависимости / риски

- Зависит от: [EPIC-005](../epic-005-multi-tenancy-rls/epic.md) (RLS), [EPIC-011](../epic-011-rbac-permissions/epic.md) (права), [EPIC-014](../epic-014-project-core/epic.md) (проект как измерение), [EPIC-019](../epic-019-tasks-core/epic.md) (задача как измерение), [EPIC-016](../epic-016-audit-log/epic.md) (журнал), [EPIC-007](../epic-007-design-system/epic.md) (виджет таймера в AppShell).
- Блокирует: [EPIC-030](../epic-030-timesheets-and-approval/epic.md), [EPIC-031](../epic-031-dashboards/epic.md), [EPIC-032](../epic-032-employee-drilldown/epic.md), [EPIC-042](../epic-042-billing-and-budget/epic.md).
- Риски:
  - **R-16** (время как источник денег) — здесь митигируется закладкой инвариантов в БД: `<> 0`, `task ⇒ project`, `UNIQUE(userId)` на таймере. Ошибка на этом уровне отравляет все инвойсы M9.
  - **`T-TIME-03`** (списание задним числом / на чужой проект) — `TimePolicy.lockAfterDays`, `allowFutureEntries`, проверка участия в проекте.
  - **`T-TIME-04`** (списание от чужого имени) — актор только из `AsyncLocalStorage`, `.strict()`-схемы на входе.
  - **`T-TIME-05`** (удаление записей без следа) — `deletedAt` + `AuditLog` с `before`.
  - **R-08** (scope creep) — таймшиты и агрегаты вынесены в отдельные эпики намеренно.

## Ссылки

- [`data-model.md` → 9. Тайм-трекинг](../../docs/architecture/data-model.md)
- [`data-model.md` → Где `EXCLUDE USING gist`](../../docs/architecture/data-model.md)
- [`permission-model.md` → 3.11 Тайм-трекинг и табели](../../docs/security/permission-model.md)
- [`threat-model.md` → STRIDE: time](../../docs/security/threat-model.md)
- [`ux-architecture.md` → Тайм-трекинг (`/time/timesheets`, таймер в шапке)](../../docs/architecture/ux-architecture.md)
- [`prd.md` → R-16, домен ТЗ 11](../../docs/product/prd.md) · [`roadmap.md` → M6](../../docs/product/roadmap.md)

## Истории

_Будут созданы на kickoff M6 через `/pm epic time-tracking-core`._
