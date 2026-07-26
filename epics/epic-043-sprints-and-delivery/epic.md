---
id: EPIC-043
title: Спринты и поставка
status: backlog
blocked: false
milestone: M9
owner: unassigned
created: 2026-07-26
---

# EPIC-043 — Спринты и поставка

## Зачем (ценность)

Задачи на доске отвечают на вопрос «что делаем», но не на вопросы «успеваем ли», «что мы обещали
заказчику к этой дате» и «что может сорвать срок». Эпик добавляет ритм поставки: спринт с ёмкостью,
майлстоун с формальной приёмкой и реестр рисков.

Самая недооценённая часть — **приёмка**. Спор «сдали или не сдали» неразрешим, если приёмка нигде не
зафиксирована: остаются переписка и разные воспоминания. `Milestone` с `acceptedAt`,
`acceptedByContactId` и файлом акта превращает приёмку в запись, на которую можно сослаться. Для
fixed-price контрактов приёмка вехи и есть событие выставления счёта.

## Scope

### В скоупе

- **`Sprint`**: имя, цель, даты, статус `PLANNED | ACTIVE | COMPLETED | CANCELLED`, `capacityHours` (ёмкость команды), `committedPoints` / `completedPoints`, `retroNotes`. Один активный спринт на проект гарантирует частичный уникальный индекс `uq_sprints_active (project_id) WHERE status = 'ACTIVE'`.
- **Планирование спринта**: набор задач в спринт, сопоставление суммарной оценки с `capacityHours`, предупреждение о перегрузе; **перенос незакрытых задач** при закрытии спринта в следующий или в бэклог — явным действием со сводкой, а не автоматически и молча.
- **Velocity и burndown**: скорость по завершённым спринтам, кривая сгорания текущего; данные берутся из задач и подтверждённых часов, а не вводятся руками.
- **`Milestone` с приёмкой заказчиком**: `dueAt`, статус `PENDING | IN_REVIEW | ACCEPTED | REJECTED`, `acceptedAt`, `acceptedByContactId` (кто со стороны клиента принял), `acceptanceNote`, `acceptanceFileId` (акт), `amountMicros`, опциональная связь с `Invoice`.
- **Дедлайны и предупреждения**: приближение `dueAt` майлстоуна и конца спринта, эскалация при незакрытом скоупе; сводка поставки по проекту (скоуп, прогресс, риски, состояние пайплайнов из [EPIC-037](../epic-037-github-integration/epic.md)).
- **`ProjectRisk`**: заголовок, описание, `probability` и `impact` (LOW/MEDIUM/HIGH), `severityScore` как **генерируемая колонка** (сортировка рисков не должна зависеть от того, посчитал ли её клиент), `status OPEN | MITIGATED | ACCEPTED | CLOSED`, владелец, план митигации, дата последнего пересмотра.
- Экраны `/delivery/sprints`, `/delivery/sprints/$sprintId` (`scope | burndown | retro`) и разделы майлстоунов и рисков в карточке проекта.

### Вне скоупа

- Доски, колонки, сами задачи и их связи — [EPIC-018](../epic-018-boards-and-columns/epic.md), [EPIC-019](../epic-019-tasks-core/epic.md); спринт — атрибут задачи (`task:manage_sprint`), а не вторая система трекинга.
- Инвойсы и бюджет — [EPIC-042](../epic-042-billing-and-budget/epic.md); здесь только связь `Milestone.invoiceId`.
- Созвоны, повестки и action items — [EPIC-044](../epic-044-calls-and-calendar/epic.md).
- Автоматическое прогнозирование сроков и обнаружение аномалий в загрузке — **Backlog** («расширенная аналитика» в `roadmap.md`).
- Story points как обязательная методология: `committedPoints` опциональны, продукт не навязывает Scrum.

## Acceptance (эпик выполнен, когда)

- [ ] Спринт создаётся, наполняется задачами, стартует и закрывается; попытка сделать второй активный спринт на проекте отклоняется базой.
- [ ] Закрытие спринта показывает сводку незакрытых задач и требует явного решения по каждой (перенести / вернуть в бэклог); молчаливого переноса не происходит.
- [ ] Суммарная оценка задач спринта сопоставляется с `capacityHours`; перегруз виден до старта, а не постфактум.
- [ ] Burndown и velocity строятся из фактических данных (статусы задач и подтверждённые часы) и совпадают с ручной сверкой на сид-данных.
- [ ] Майлстоун принимается заказчиком: фиксируются `acceptedAt`, `acceptedByContactId`, заметка и файл акта; изменение принятого майлстоуна требует отдельного действия и пишется в аудит с состоянием до и после.
- [ ] `milestone:accept` — опасное право с подтверждением в UI; приёмку невозможно выполнить «мимоходом».
- [ ] Для fixed-price контракта принятый майлстоун связывается со счётом; сумма майлстоуна и сумма счёта сходятся.
- [ ] `severityScore` вычисляется базой (`GENERATED ALWAYS AS`), а не клиентом; сортировка открытых рисков стабильна и покрыта тестом.
- [ ] Предупреждения о приближении дедлайна и о просроченном майлстоуне отправляются один раз на событие независимо от числа каналов доставки.
- [ ] Сводка поставки показывает состояние пайплайнов при подключённой GitHub-интеграции и корректное пустое состояние при отключённой (NFR-9).
- [ ] Пользователь без доступа к проекту не видит его спринты, майлстоуны и риски ни в кросс-проектном списке `/delivery/sprints`, ни по прямой ссылке.
- [ ] Кросс-тенантный негативный тест на `Sprint`, `Milestone`, `ProjectRisk`.

## Модель данных

- Затрагиваемые сущности: `Sprint` [T], `Milestone` [T], `ProjectRisk` [T], `Task` [T] (`sprintId`), `Project` [T], `Contract` [T], `Invoice` [T], `ClientContact` [T], `File` [T] (акт приёмки), `AuditLog` [T].
- Новые поля/таблицы и расхождения:
  - **`Milestone.acceptanceNote` отсутствует.** В [`data-model.md`](../../docs/architecture/data-model.md) §13 у `Milestone` есть `acceptedAt`, `acceptedByContactId`, `acceptanceFileId`, но текстового комментария приёмки нет — требуется добавить.
  - **`Milestone.acceptedById` против `acceptedByContactId`.** Модель фиксирует, кто принял **со стороны клиента** (`ClientContact`); кто оформил приёмку **с нашей стороны** — не фиксируется. Требуется решение: добавить `acceptedById` (внутренний пользователь) или считать достаточным `AuditLog`.
  - **`Milestone` объявлен в двух контекстах.** [`overview.md`](../../docs/architecture/overview.md) относит `Milestone` к контексту `project`, [`data-model.md`](../../docs/architecture/data-model.md) описывает его в группе 13 (`delivery`). Владелец сущности обязан быть один — расхождение требует правки до реализации, иначе появятся два репозитория одной таблицы, что прямо запрещено правилом «чужие таблицы контекст не читает».
  - `Sprint.capacityHours Int` — ёмкость в часах, тогда как загрузка сотрудника выражена `EmployeeProfile.weeklyCapacityHours`; связь между ними (как считается ёмкость спринта из состава команды) не описана — вычисляется или задаётся руками, требуется зафиксировать.
  - `ProjectRisk.reviewedAt` есть, но нет правила «риск не пересматривался N дней → напомнить»; поле бесполезно без потребителя.
  - `Task.sprintId` — поле принадлежит контексту `task`; изменение состава спринта выполняется use-case'ом владельца задач, а не прямым апдейтом из `delivery`.
- `uq_sprints_active (project_id) WHERE status = 'ACTIVE'` — инвариант в БД, не в приложении.

## Права

- Новые ключи (из каталога [`permission-model.md` §3.5 и §3.16](../../docs/security/permission-model.md)): `sprint:read`, `sprint:create`, `sprint:update`, `sprint:start`, `sprint:complete`, `sprint:delete`, `task:manage_sprint`, `milestone:read`, `milestone:create`, `milestone:update`, `milestone:accept` (**опасное**), `risk:read`, `risk:create`, `risk:update`, `risk:close`, `delivery:access` (шлюз в кросс-проектные экраны).
- Требуемые ACL-уровни: `sprint:read`, `milestone:read`, `risk:read` — `VIEWER` на проект; `sprint:create/update/start/complete`, `task:manage_sprint`, `milestone:create/update`, `risk:create/update` — `EDITOR`; `sprint:delete`, `milestone:accept`, `risk:close` — `MANAGER`.
- Опасное: `milestone:accept` — единственное опасное право эпика, и это правильно: приёмка порождает финансовые последствия (для fixed-price — событие выставления счёта) и юридически значима.
- Отдельно: файл акта приёмки подчиняется `file:read` / `file:download` с ACL на файл; выдача presigned-ссылки — в аудит.
- Кросс-проектные экраны (`/delivery/sprints`) показывают только проекты, доступные актору: фильтрация в запросе, а не скрытие в UI.

## Зависимости / риски

- Зависит от: [EPIC-041](../epic-041-client-and-contract/epic.md) (контракт, `ClientContact` как принимающая сторона), [EPIC-042](../epic-042-billing-and-budget/epic.md) (связь приёмки со счётом), [EPIC-019](../epic-019-tasks-core/epic.md) (задачи и оценки), [EPIC-014](../epic-014-project-core/epic.md), [EPIC-037](../epic-037-github-integration/epic.md) (статусы пайплайнов в сводке поставки), [EPIC-029](../epic-029-time-tracking-core/epic.md)/[EPIC-030](../epic-030-timesheets-and-approval/epic.md) (часы для burndown), [EPIC-028](../epic-028-notifications/epic.md).
- Блокирует: [EPIC-044](../epic-044-calls-and-calendar/epic.md) (`ActionItem.sourceType` включает `MILESTONE` и `RISK`).
- Риски:
  - **Спор о приёмке** — основной продуктовый риск персоны P2; закрывается тем, что приёмка является записью с актом, контактом и временем, а не перепиской.
  - **Двойное владение `Milestone`** между контекстами `project` и `delivery` — архитектурный риск: два репозитория одной таблицы нарушают правило bounded contexts и приводят к расхождению инвариантов.
  - **R-08** (scope creep) — соблазн построить полноценный планировщик ресурсов и прогноз сроков; расширенная аналитика зафиксирована в Backlog.
  - **R-18** (сравнение с конкурентом) — Jira-подобное управление спринтами богаче; наша ценность — связь спринта с часами, бюджетом и приёмкой, а не паритет функций.
  - `T-PROJ-*` — приватный проект не должен раскрываться через кросс-проектные списки спринтов и рисков; `permission-matrix` snapshot покрывает эти экраны как вторичный путь.

## Ссылки

- [`data-model.md` → 13. Ритм проекта (`Sprint`, `Milestone`, `ProjectRisk`)](../../docs/architecture/data-model.md)
- [`overview.md` → Ограниченные контексты (`project`, `delivery`)](../../docs/architecture/overview.md)
- [`permission-model.md` → 3.5, 3.16](../../docs/security/permission-model.md)
- [`ux-architecture.md` → Delivery (спринты, майлстоуны)](../../docs/architecture/ux-architecture.md)
- [`prd.md` → домен ТЗ 18, персона P2](../../docs/product/prd.md) · [`roadmap.md` → M9](../../docs/product/roadmap.md)

## Истории

_Будут созданы на kickoff M9 через `/pm epic sprints-and-delivery`._
