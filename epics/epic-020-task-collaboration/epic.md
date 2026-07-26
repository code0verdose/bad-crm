---
id: EPIC-020
title: Обсуждение задач — комментарии, вложения, активность
status: backlog
blocked: false
milestone: M3
owner: unassigned
created: 2026-07-26
---

# EPIC-020 — Обсуждение задач — комментарии, вложения, активность

## Зачем (ценность)

Разорванный контекст — боль №1 из PRD: задача в трекере, обсуждение в мессенджере, скриншот в чате.
Эпик собирает обсуждение в одном месте: комментарии с упоминаниями, вложенные файлы и вставленные из
буфера скриншоты, наблюдатели и лента изменений задачи. Здесь же создаётся **централизованный слой
доступа к полиморфным ссылкам** — единственный правильный ответ на риск `R-11` и угрозу `T-TASK-06`:
комментарий и вложение читаются по собственному id, поэтому доступ к ним обязан резолвиться через
родителя.

## Scope

### В скоупе

- `Comment` (полиморфный, `entityType` — **PostgreSQL enum** `TASK | DOC_PAGE | KB_NOTE | CALL`,
  whitelist на уровне БД, а не в коде): создание, редактирование своего/чужого, удаление, ветка
  ответов (`parentCommentId`), пометка «решено» (`resolvedAt`), `body Json` + `plainText`.
- Меншны: разбор `@user` и `@team` из тела комментария, запись `Mention`, доставка адресату
  (в M3 — счётчик и лента упоминаний; полноценный центр уведомлений — EPIC-028).
- Вложения: `Attachment` (полиморфный) → `File` из [EPIC-015](../epic-015-file-storage/epic.md);
  загрузка через presigned PUT (ключ формирует сервер), привязка к задаче и к комментарию, подпись
  (`caption`), удаление привязки без физического удаления файла, если он ещё используется
  (`idx_attachments_file`).
- **Вставка изображения из буфера** (Ctrl+V скриншота) и drag&drop файла в поле комментария:
  загрузка с прогрессом, превью, отмена; ограничения размера и типа.
- Watchers: `Watcher` с причиной `EXPLICIT | ASSIGNED | AUTHORED | MENTIONED`, подписка и отписка,
  автоподписка при назначении/авторстве/упоминании.
- Лента активности задачи: `ActivityEvent` (append-only) — `task.created`, `task.moved`,
  `task.assigned`, `task.field_changed`, `comment.created`, `attachment.added`; **whitelist полей**
  в `payload` (`T-TASK-03`), рендер ленты во вкладке `activity` карточки задачи.
- Централизованный `PolymorphicParentResolver`: единственная точка, через которую читаются
  `Comment`, `Attachment`, `ActivityEvent`, `Watcher`, `Mention`; резолвит родителя по
  (`entityType`, `entityId`) и проверяет права на него.
- Каскадное удаление в **одном доменном сервисе и одной транзакции**: удаление задачи снимает
  комментарии, вложения, ACL, watchers, mentions, события и порождает outbox-событие на удаление
  объектов в S3; ночной integrity-джоб на анти-джойнах отдаёт **метрику и алерт**, а не тихо чистит.
- Санитизация контента комментария (общий санитайзер, whitelist протоколов `http/https/mailto`).

### Вне скоупа

- Центр уведомлений, email-дайджесты, тихие часы — [EPIC-028](../epic-028-notifications/epic.md) (M5).
- Комментарии к документам и заметкам как продуктовый сценарий — [EPIC-022](../epic-022-docs-pages/epic.md),
  [EPIC-023](../epic-023-knowledge-base/epic.md) (M4); здесь закладывается только полиморфный механизм.
- Сообщения чата и реакции — [EPIC-026](../epic-026-chat-core/epic.md),
  [EPIC-027](../epic-027-chat-rich-messaging/epic.md) (M5).
- Приватные задачи и UI выдачи доступа — [EPIC-021](../epic-021-task-access-control/epic.md).
- Живое появление комментария без перезагрузки — [EPIC-025](../epic-025-realtime-infrastructure/epic.md) (M5).
- Антивирусное сканирование вложений — принятый риск 1.0 (`T-FILE-05`), порт объявлен в EPIC-015.

## Acceptance (эпик выполнен, когда)

- [ ] Комментарий создаётся, редактируется автором, удаляется автором; редактирование/удаление
      чужого требует `comment:update_any` / `comment:delete_any` и пишется в `AuditLog`.
- [ ] **`T-TASK-06` закрыт:** запрос `GET /attachments/{id}` и `GET /comments/{id}` по валидному id
      пользователем, у которого отозван доступ к родительской задаче, возвращает 404. Тест
      `polymorphic-parent-check` покрывает не менее 12 подресурсов (комментарий, ответ, вложение,
      превью, скачивание, лента, watchers, упоминания, экспорт, счётчики).
- [ ] Ни один путь чтения полиморфной сущности не обходит `PolymorphicParentResolver` —
      проверяется архитектурным тестом (нет прямых обращений к `prisma.comment/attachment` вне
      резолвера и репозитория).
- [ ] `Comment.entityType` — enum PostgreSQL: попытка вставить неизвестный тип отклоняется базой,
      а не приложением (негативный тест на уровне SQL).
- [ ] Скриншот из буфера вставляется в комментарий, загружается, появляется превью; при отмене
      загрузки объект в S3 не остаётся (джоб зачистки `PENDING` покрыт тестом).
- [ ] Удаление задачи в одной транзакции снимает комментарии, вложения, watchers, mentions, ACL и
      ставит объекты S3 в очередь удаления; ночной integrity-джоб на сид-данных находит **ноль**
      сирот (`R-11`).
- [ ] Файл, на который ещё ссылается другое вложение, не удаляется физически (проверка по
      `idx_attachments_file`).
- [ ] `ActivityEvent.payload` содержит только поля из whitelist; тест `activity-payload-whitelist`
      и снапшот payload по типам событий зелёные; поля, недоступные читателю (оценка, приватное
      описание), в ленту не попадают (`T-TASK-03`).
- [ ] Упоминание создаёт `Mention` ровно один раз на пользователя на комментарий (повторное
      сохранение того же текста не плодит записи); упоминание пользователя без доступа к задаче
      не создаёт запись и подсвечивается в редакторе как недоступное.
- [ ] XSS-корпус (`xss-payload-corpus`) на поле комментария не проходит: `javascript:`,
      `data:`, сырой HTML, SVG-вложение отдаются как `attachment` и не исполняются.
- [ ] Лента комментариев задачи с 500 комментариями отдаётся за p95 < 300 мс по индексу
      `idx_comments_entity`, без N+1 по авторам и вложениям.

## Модель данных

- Затрагиваемые сущности: `Comment` **[T]**, `Attachment` **[T]**, `Mention` **[T]**,
  `Watcher` **[T]**, `ActivityEvent` **[T]**, `File` **[T]** / `FileVersion` **[T]** (EPIC-015),
  `Task` **[T]** (родитель), `OutboxEvent` **[T]**, `AuditLog` **[T]**.
- Индексы: `idx_comments_entity (organization_id, entity_type, entity_id, created_at) WHERE
  deleted_at IS NULL`; `idx_attachments_entity`, `idx_attachments_file (file_id)`;
  `idx_mentions_user_unread (organization_id, mentioned_user_id) WHERE read_at IS NULL`;
  `uq_watchers (entity_type, entity_id, user_id)`;
  `idx_activity_events_entity (…, occurred_at DESC)`, `idx_activity_events_actor`.
- Полиморфия сохраняется осознанно (решение зафиксировано в data-model → «Полиморфные связи»):
  раздельные таблицы на тип родителя превратили бы «мою ленту комментариев» в `UNION ALL` по N таблицам.
  Компенсация — enum-дискриминатор, каскад в одном сервисе, integrity-джоб, обратные индексы.
- `Comment.body` / `ActivityEvent.payload` — JSONB с полем версии схемы, валидация Zod на границе.
- **Пробел модели:** `Attachment.entityType` в таблице сущностей не перечислен явными значениями
  (в разделе «Полиморфные связи» указаны задачи, документы, заметки, комментарии, вехи, риски).
  Требуется зафиксировать Prisma enum `AttachmentEntityType` с этим набором до первой миграции,
  иначе дискриминатор разъедется с `Comment.entityType`.
- **Пробел модели:** у `Comment` нет счётчика ответов (`replyCount`), из-за чего дерево ответов
  требует дополнительного агрегата. Либо денормализованный счётчик, либо ограничение «один уровень
  ответов» — решение фиксируется в эпике.
- **Пробел модели:** `Mention` содержит и `commentId?`/`messageId?`, и пару `sourceType`/`sourceId` —
  два способа выразить одно. Нужно оставить один (рекомендуется `sourceType`/`sourceId` как
  полиморфный, согласованный с остальными таблицами) и убрать дубль.

## Права

- Ключи из каталога §3.5: `comment:read` (`VIEWER`), `comment:create` (`COMMENTER`),
  `comment:update_own` (`COMMENTER`), `comment:update_any` (`EDITOR`, **dangerous**),
  `comment:delete_own` (`COMMENTER`), `comment:delete_any` (`EDITOR`, **dangerous**),
  `comment:resolve` (`COMMENTER`), `task:watch` (`VIEWER`), `task:read` (`VIEWER`).
- Файловые (§3.8): `file:upload` (`EDITOR`), `file:read` (`VIEWER`), `file:download` (`VIEWER`),
  `file:delete` (`EDITOR`).
- ACL-уровни и наследование: `Comment` / `Attachment` / `ActivityEvent` / `Watcher`
  **собственного ACL не имеют по построению** — наследуют цепочку родителя
  (`entityType` + `entityId` → `Task → Board → Project → Organization`). Уровень `COMMENTER`
  на задаче даёт право комментировать, но не редактировать задачу.
- Отсутствующих ключей нет. Отдельного `attachment:*` каталог не предусматривает сознательно:
  вложение управляется правами файла и правами родительской сущности.

## Зависимости / риски

- Зависит от: EPIC-019 (задача как родитель), EPIC-015 (файловый слой и presigned-загрузка),
  EPIC-011 (права и ACL), EPIC-016 (audit log), EPIC-005 (RLS).
- Блокирует: EPIC-021 (приватная задача должна скрывать и комментарии, и вложения),
  EPIC-024 (индексация комментариев и вложений с учётом прав),
  EPIC-028 (упоминания и watchers — источник уведомлений),
  EPIC-027 (вложения чата переиспользуют тот же слой проверки родителя).
- Риски:
  - `R-11` / `T-TASK-06` — **ключевой риск эпика**: сироты в полиморфных таблицах и чтение
    вложения/комментария по собственному id без проверки родителя. Митигация описана в Scope и
    Acceptance целиком.
  - `T-TASK-03` — утечка через `ActivityEvent.payload`: whitelist полей + фильтрация ленты по правам
    на конкретные поля.
  - `T-FILE-02` / `R-12` — утечка presigned URL: TTL ≤ 15 минут, выдача только после проверки ACL в
    момент запроса, маскирование подписи в логах.
  - `T-FILE-06` — XSS через отдачу файла: `attachment` + `nosniff`, запрет inline `text/html` и
    `image/svg+xml`.
  - `T-KNOW-01` — stored XSS через контент: общий санитайзер и whitelist протоколов на рендере.

## Ссылки

- Документация: [prd.md → R-11](../../docs/product/prd.md) ·
  [roadmap.md → M3](../../docs/product/roadmap.md#m3--задачи) ·
  [data-model.md §4 + «Полиморфные связи»](../../docs/architecture/data-model.md) ·
  [ux-architecture.md → Карточка задачи](../../docs/architecture/ux-architecture.md) ·
  [permission-model.md §3.5, §3.8, «Наследование ACL»](../../docs/security/permission-model.md) ·
  [threat-model.md `T-TASK-03`, `T-TASK-06`, `T-FILE-02/06`](../../docs/security/threat-model.md)
- Правила: `rules/permissions.mdc`, `rules/polymorphic-access.mdc`, `rules/file-uploads.mdc`
  (каталог `rules/` пока пуст — файлы создаются при старте M3)

## Истории

_Будут созданы на kickoff M3 через `/pm epic task-collaboration`._
