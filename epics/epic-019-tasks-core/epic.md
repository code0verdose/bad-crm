---
id: EPIC-019
title: Задачи — ядро
status: backlog
blocked: false
milestone: M3
owner: unassigned
created: 2026-07-26
---

# EPIC-019 — Задачи — ядро

## Зачем (ценность)

Задача — центральная единица ежедневной работы и точка, к которой пристёгиваются время, файлы,
документы, коммиты и сообщения. Пока задачи нет, весь остальной граф продукта не с чем связывать.
Эпик даёт полный жизненный цикл задачи (создание, поля, исполнители, метки, подзадачи, связи),
перетаскивание по доске без «прыгающих» карточек и списки с фильтрами, состояние которых целиком
живёт в URL. Закрытие эпика — момент, когда команда физически может вести работу в Bad CRM.

## Scope

### В скоупе

- CRUD задачи: `title`, `description Json` (rich-text того же формата, что `DocPage.content`),
  `priority`, `status`, `estimateMinutes`, `dueAt`, `startedAt`, `completedAt`, мягкое удаление и
  восстановление.
- Человекочитаемый номер `Task.number` в рамках проекта (`BAD-42`) через
  `UPDATE projects SET task_counter = task_counter + 1 RETURNING …` в той же транзакции, что вставка.
- Мульти-исполнители: `TaskAssignee` с `isPrimary`, назначение и снятие, экран «мои задачи»
  по индексу `idx_task_assignees_org_user`.
- Метки: `Label` (проектные и организационные) + `TaskLabel`, управление метками проекта.
- Подзадачи через `Task.parentTaskId`: дерево одного уровня вложенности в UI, прогресс по детям.
- Связи `TaskLink`: `BLOCKS | RELATES | DUPLICATES | CAUSES`, нормализация порядка для симметричных
  типов, запрет самоссылки, **детект циклов `BLOCKS`** в use-case с внятной ошибкой и подсветкой цепочки.
- **Drag & drop с fractional indexing:** перемещение внутри колонки и между колонками меняет
  `Task.orderKey` (и `boardColumnId`) одной строкой; оптимистичное обновление кеша TanStack Query
  с snapshot → `onError` rollback → `onSettled` invalidate; проверка WIP-лимита (EPIC-018) и
  простановка `completedAt` в `isDone`-колонке.
- Списки задач: `/tasks` и бэклог проекта — фильтры по исполнителю, метке, приоритету, статусу,
  сроку, проекту; **все фильтры в URL** через `validateSearch: zodValidator(taskListSearchSchema)`,
  debounce 300 мс на текстовый ввод, `signal` из TanStack Query пробрасывается в fetch (отмена при
  смене ключа), `placeholderData: keepPreviousData`.
- `SavedView` — сохранённые представления списка (именованный набор фильтров, личный или командный)
  с переходом на него как на URL.
- Карточка задачи: дровер `?task=` поверх доски и полноценная страница `/tasks/$taskId` — один
  компонент, два контейнера.
- Массовые операции над выборкой задач (смена статуса, исполнителя, метки) за `task:bulk_edit`.
- Экспорт списка задач за `task:export`.

### Вне скоупа

- Доски и колонки как контейнер — [EPIC-018](../epic-018-boards-and-columns/epic.md).
- Комментарии, вложения, watchers, лента активности — [EPIC-020](../epic-020-task-collaboration/epic.md).
- Приватные задачи и фильтрация списков по правам одним SQL — [EPIC-021](../epic-021-task-access-control/epic.md).
- Спринты, оценка в story points, burndown — [EPIC-043](../epic-043-sprints-and-delivery/epic.md) (M9);
  поле `Task.sprintId` существует, но управление спринтом сюда не входит.
- Списание времени по задаче — [EPIC-029](../epic-029-time-tracking-core/epic.md) (M6).
- Поиск по задачам — [EPIC-024](../epic-024-search-meilisearch/epic.md) (M4).
- Живое обновление доски и задач по сокету — [EPIC-025](../epic-025-realtime-infrastructure/epic.md) (M5).

## Acceptance (эпик выполнен, когда)

- [ ] Полный жизненный цикл проходит e2e: создать → назначить двух исполнителей → перетащить по
      доске → связать `BLOCKS` → добавить подзадачу → закрыть; после перезагрузки состояние то же.
- [ ] `Task.number` уникален внутри проекта (`uq_tasks_project_number`), не имеет дыр от откатов
      соседних проектов и присваивается в одной транзакции со вставкой — покрыто конкурентным тестом
      на 50 параллельных созданий в одном проекте.
- [ ] Перетаскивание карточки меняет **одну** строку (`orderKey`, при необходимости
      `boardColumnId`); тест считает изменённые строки. Конкурентное перетаскивание двумя
      пользователями в одну позицию не приводит к потере порядка и не «схлопывает» карточки: обе
      задачи получают различимые ключи, порядок детерминирован, тест `concurrent-reorder` зелёный.
- [ ] Оптимистичное обновление откатывается при ошибке сервера: карточка возвращается на исходное
      место, показывается ровно один тост (глобальный `MutationCache.onError`, без дубля из
      локального `onError`).
- [ ] Попытка создать цикл `BLOCKS` (A→B→C→A) отклоняется с ошибкой, содержащей цепочку; покрыто
      тестом на цикл длиной 2 и длиной 3+.
- [ ] Симметричные связи не дублируются зеркально: создание `RELATES` A→B и затем B→A даёт конфликт
      уникальности, а не вторую строку.
- [ ] Состояние списка (фильтры, сортировка, страница, открытая задача) полностью восстанавливается
      из URL, валидируется Zod-схемой, мусор в параметрах отбрасывается схемой, а не кодом;
      смена любого фильтра сбрасывает `page`.
- [ ] Смена фильтра отменяет предыдущий запрос (`signal`), `AbortError` не показывается как ошибка;
      при смене страницы список не мигает (`keepPreviousData`).
- [ ] `SavedView` сохраняет и восстанавливает набор фильтров; открытие представления даёт тот же
      URL, что ручная настройка фильтров.
- [ ] p95 списочного эндпоинта задач < 300 мс на сид-данных 10 000 задач; тест на число SQL-запросов
      не находит N+1 (исполнители, метки, счётчики подзадач загружаются пачкой).
- [ ] Актор не принимается из тела запроса: `createdById`/`assignedById` берутся из контекста сессии,
      входные Zod-схемы `.strict()` (`T-TASK-04`).

## Модель данных

- Затрагиваемые сущности: `Task` **[T]**, `TaskAssignee` **[T]**, `TaskLink` **[T]**, `Label` **[T]**,
  `TaskLabel` **[T]**, `BoardColumn` **[T]** (из EPIC-018), `Project.taskCounter` **[T]**,
  `AuditLog` **[T]**, `OutboxEvent` **[T]**.
- Ключевые индексы: `uq_tasks_project_number (project_id, number)`;
  `idx_tasks_board_order (organization_id, board_column_id, order_key) WHERE deleted_at IS NULL`;
  `idx_tasks_org_parent`, `idx_tasks_org_due (…) WHERE completed_at IS NULL`;
  `uq_task_assignees (task_id, user_id)`; `uq_task_links (source_task_id, target_task_id, link_type)`;
  `idx_tasks_search GIN (search_vector)` — `search_vector` обновляется триггером из
  `title + plainText(description)`.
- `Task.orderKey String` — fractional index (base62), не `position Int`; вставка между соседями
  меняет одну строку. Ребалансировка при превышении длины ключа — фоновая задача.
- `Task.description` — JSONB с полем версии схемы (`{"v":1,…}`), валидируется Zod на границе;
  рядом хранится plain-text для полнотекста.
- **Закрыто (2026-07-26):** `Task.type` добавлен в data-model как Prisma enum `TaskType`. **Канон —
  `TASK | BUG | STORY | CHORE`**: значение `EPIC` заменено на `CHORE`, потому что «эпик» в этом
  проекте — единица планирования работ над самим продуктом (каталог `epics/`), и одноимённый тип
  задачи гарантированно породил бы путаницу; иерархия «крупное → мелкое» выражается `parentTaskId`,
  а не типом.
- **Закрыто (2026-07-26):** `SavedView` **[T]** описан в data-model, группа 15 (`userId?`,
  `scope PERSONAL|PROJECT|ORGANIZATION`, `entityType`, `projectId?`, `name`, `queryParams Json`,
  `isShared`, `isDefault`). Обратите внимание на имя поля: **`queryParams`**, не `queryJson`, — это
  сериализованные search-параметры маршрута ровно в том виде, в каком они живут в URL.
- **Закрыто (2026-07-26):** `Task` имеет одновременно `status` и `boardColumnId`. **Канон —
  источник правды `boardColumnId`**, `status` производный и синхронизируется use-case'ом
  перемещения/создания задачи (маппинг «колонка → статус» в `Board.settings`). Правила, записанные в
  data-model: `status` пишет только этот use-case; поля `status` нет в payload обновления задачи
  вообще; расхождение ловится ночным integrity-джобом и контрактным тестом «после `task:move`
  `status` соответствует колонке». `status` оставлен, а не удалён, ради кросс-проектных отчётов и
  стабильного контракта API.
- **Закрыто (2026-07-26):** `Task.boardId` денормализован (при сохранении `boardColumnId`); инвариант
  держит составной FK `(organization_id, board_id, board_column_id) → board_columns`, поэтому
  рассинхронизация при перемещении задачи между досками — ошибка вставки, а не тихое расхождение.
- Циклы `BLOCKS` не запрещаются БД (это потребовало бы рекурсивного триггера) — валидатор в use-case.

## Права

- Ключи из каталога §3.5: `task:read` (`VIEWER`), `task:create` (`EDITOR`), `task:update` (`EDITOR`),
  `task:move` (`EDITOR`), `task:assign` (`EDITOR`), `task:estimate` (`EDITOR`), `task:link` (`EDITOR`),
  `task:manage_labels` (`EDITOR`), `task:watch` (`VIEWER`), `task:delete` (`EDITOR`),
  `task:restore` (`EDITOR`), `task:bulk_edit` (`EDITOR`, **dangerous**), `task:export` (`VIEWER`),
  `task:manage_sprint` (`EDITOR`, используется частично — только простановка `sprintId`).
- Сопутствующие: `project:manage_labels` (`EDITOR`) — управление каталогом меток проекта;
  `board:read` (`VIEWER`), `board:override_wip_limit` (`EDITOR`) — при перемещении.
- ACL-уровни и наследование: `Task → Board → Project → Organization`. Каждое чтение задачи, включая
  чтение по прямой ссылке `/tasks/$taskId` и по номеру `BAD-42`, резолвит ACL родителя; fail-closed.
  Перемещение (`task:move`) — полноценная мутация с проверкой `EDITOR`, а не «быстрый путь».
- Отсутствующих ключей нет. Для `SavedView` отдельное право не заводится: личное представление —
  собственность пользователя, командное требует `EDITOR` на проекте.

## Зависимости / риски

- Зависит от: EPIC-018 (доска и колонки), EPIC-014 (проект и `taskCounter`), EPIC-011 (права),
  EPIC-005 (RLS), EPIC-004 (TanStack Router/Query, схемы search-параметров).
- Блокирует: EPIC-020 (обсуждение и вложения задач), EPIC-021 (приватные задачи и фильтрация
  списков), EPIC-024 (индексация задач), EPIC-025 (живые события доски), EPIC-029 (списание времени
  на задачу, M6), EPIC-043 (спринты, M9).
- Риски:
  - **Конкурентное перетаскивание двумя пользователями** — основной риск эпика. Митигация:
    fractional index (конфликт неразрушающий), генерация ключа на сервере от актуальных соседей
    (клиент присылает `beforeId`/`afterId`, а не готовый ключ), идемпотентность повторного запроса,
    тест `concurrent-reorder` на одновременный перенос в одну позицию, ребалансировка ключей фоном.
  - `T-TASK-01` (IDOR по задаче): перебор `BAD-1…BAD-N` — ACL проверяется на каждом чтении, включая
    подресурсы; тест `task-idor-matrix`.
  - `T-TASK-02` (мутация без проверки): `move`/`reorder` включены в контрактный тест route↔policy.
  - `T-TASK-04` (подделка авторства): актор только из контекста сессии, входные схемы `.strict()`.
  - `T-TASK-05` (раздувание данными): rate-limit 300 req/мин, лимит размера `description`,
    квота организации на число задач.
  - `R-08`: соблазн затащить спринты и оценку в story points — вне скоупа до M9.

## Ссылки

- Документация: [prd.md](../../docs/product/prd.md) (домен ТЗ 4) ·
  [roadmap.md → M3](../../docs/product/roadmap.md#m3--задачи) ·
  [data-model.md §4 + «Порядок элементов»](../../docs/architecture/data-model.md) ·
  [ux-architecture.md → Карточка задачи, Списки и фильтры, Drag & drop](../../docs/architecture/ux-architecture.md) ·
  [permission-model.md §3.5](../../docs/security/permission-model.md) ·
  [threat-model.md `T-TASK-01…06`](../../docs/security/threat-model.md)
- Правила: `rules/frontend-fsd.mdc`, `rules/tanstack-query.mdc`, `rules/permissions.mdc`,
  `rules/db-migrations.mdc` (каталог `rules/` пока пуст — файлы создаются при старте M3)

## Истории

_Будут созданы на kickoff M3 через `/pm epic tasks-core`._
