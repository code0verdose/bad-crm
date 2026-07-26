---
id: EPIC-023
title: База знаний Obsidian-like
status: backlog
blocked: false
milestone: M4
owner: unassigned
created: 2026-07-26
---

# EPIC-023 — База знаний Obsidian-like

## Зачем (ценность)

Требование ТЗ прямое: база знаний в стиле Obsidian с импортом и экспортом `.md`. Команда не станет
переносить накопленный vault в инструмент, из которого его нельзя забрать обратно, поэтому источник
правды здесь — **чистый Markdown**, а не внутренний формат приложения. Эпик даёт заметки, `[[wiki-links]]`
с обратными ссылками и незаполненными заметками, теги, граф связей, пространства с правами и
пакетный импорт существующего vault-а. Обратимость миграции — сама ценность, а не приятное дополнение.

## Scope

### В скоупе

- `KbNote` с **`contentMd Text` как источником правды** и `frontmatter Json`; заметка идентифицируется
  путём внутри пространства (`uq_kb_notes_space_path`), `checksum` sha256 сырого файла для детекта
  изменений и конфликтов.
- Редактор: **CodeMirror 6** с markdown-подсветкой, режимы `read | edit | split`; рендер через
  remark/rehype + `remark-wiki-link` + **`rehype-sanitize` со строгой схемой на рендере и на импорте**.
- `[[wiki-links]]` и backlinks: `KbLink` (`WIKI | EMBED | TAG`), `targetTitleRaw` хранится всегда,
  `targetNoteId` нуллабелен, `isBroken` — денормализованный флаг незаполненных заметок;
  переименование заметки массово чинит ссылки одним `UPDATE`.
- Теги: `KbTag` + `KbNoteTag` с источником `FRONTMATTER | INLINE | MANUAL`; фильтр по тегам в URL.
- Граф связей: **Sigma.js + graphology**, узлы — заметки, размер по числу входящих ссылок,
  фокус/глубина/теги/сироты в search-параметрах (`kbGraphSearchSchema`).
- **Импорт и экспорт `.md`**: экспорт пространства в каталог `.md` (frontmatter + вложения),
  импорт каталога/архива Obsidian; `KbImportJob` для пакетного импорта (`QUEUED | RUNNING |
  SUCCEEDED | FAILED | PARTIAL`, `stats`, `errorLog`, отчёт по каждому файлу).
- **Round-trip тест «импорт → экспорт → импорт»**: результат идентичен, `checksum` совпадает,
  wiki-links, теги, frontmatter и вложения не теряются.
- Пространства `KbSpace` (`sourceKind NATIVE | GIT | OBSIDIAN_IMPORT`) — личные и командные,
  привязка к проекту, права на пространство через `ResourceAcl`.
- Мягкое удаление заметки, история изменений на уровне `AuditLog` (полноценное версионирование
  заметок в 1.0 не вводится — источник версий при `sourceKind = GIT` это сам git).
- Валидация путей при импорте: запрет `..`, ведущего `/`, NUL и управляющих символов; ключ объекта
  в S3 строится сервером.

### Вне скоупа

- Блочные документы Notion-like — [EPIC-022](../epic-022-docs-pages/epic.md).
- Глобальный поиск по заметкам — [EPIC-024](../epic-024-search-meilisearch/epic.md).
- Двусторонняя синхронизация с git-репозиторием как процесс (`kb_space:sync_git` объявлен, но
  автоматический pull/push вне 1.0) — backlog; в скоупе только `sourceKind` и разовый импорт.
- Совместное редактирование (CRDT) — backlog 1.0.
- AI-ответы по базе знаний и эмбеддинги — [EPIC-039](../epic-039-ai-assistant/epic.md) (M8).
- Материалы и онбординг поверх KB — [EPIC-040](../epic-040-onboarding-materials/epic.md) (M8).

## Acceptance (эпик выполнен, когда)

- [ ] Заметка создаётся, редактируется в трёх режимах (`read`/`edit`/`split`) и сохраняется как
      **чистый Markdown**: содержимое `contentMd` побайтово совпадает с тем, что видит пользователь
      в режиме `edit` (никакого промежуточного формата).
- [ ] Импорт каталога Obsidian на ≥ 200 заметок восстанавливает структуру папок, frontmatter, теги,
      wiki-links и вложения; отчёт `KbImportJob.stats` содержит число заметок, ссылок, вложений,
      пропущенных и ошибочных файлов.
- [ ] **Round-trip зелёный:** импорт → экспорт → импорт даёт идентичный результат (совпадение
      `checksum` каждой заметки и полное совпадение множества `KbLink`); тест прогоняется на
      эталонном vault-корпусе, включающем кириллицу, пробелы в путях, вложенные папки, embeds и
      битые ссылки.
- [ ] Экспортированные файлы открываются в Obsidian без правок (проверяется чек-листом и
      фикстурой-эталоном в репозитории).
- [ ] `[[Ссылка на несуществующую заметку]]` создаётся как незаполненная (`isBroken = true`,
      `targetNoteId = null`), отображается отдельным стилем и превращается в рабочую при создании
      заметки с таким заголовком — без ручного пересканирования.
- [ ] Переименование заметки чинит все входящие ссылки одним запросом; отчёт «битые ссылки»
      выполняется индексным запросом (`idx_kb_links_broken`), а не обходом графа.
- [ ] Backlinks заметки отдаются одним индексным чтением (`idx_kb_links_target`) и содержат только
      доступные пользователю заметки.
- [ ] **Граф строится после фильтрации по правам** (`T-KNOW-05`): недоступный узел не показывается
      даже серым, его заголовок не утекает через `targetTitleRaw`; e2e-тест `kb-graph-respects-acl`.
- [ ] Импорт защищён от path traversal и zip-bomb: корпус `kb-import-path-traversal-corpus`
      отклоняется; превышение лимитов (размер архива, распакованный размер, число файлов, глубина)
      прерывает импорт со статусом `FAILED`/`PARTIAL` и внятным `errorLog` (`T-KNOW-02`, `T-KNOW-03`).
- [ ] `xss-payload-corpus` на рендере и **на импорте** не проходит: сырой HTML, `javascript:`/`data:`,
      `onerror`, SVG-вложение (`T-KNOW-01`).
- [ ] Экспорт пространства содержит только доступные пользователю заметки, пишется в `AuditLog`
      с числом заметок и ограничен по объёму и частоте (`T-KNOW-07`).
- [ ] Пространство, недоступное по ACL, не видно в списке, по прямой ссылке (404) и в графе.

## Модель данных

- Затрагиваемые сущности: `KbSpace` **[T]**, `KbNote` **[T]**, `KbLink` **[T]**, `KbTag` **[T]**,
  `KbNoteTag` **[T]**, `KbImportJob` **[T]**, `Attachment` **[T]** / `File` **[T]** (вложения
  заметок), `Comment` **[T]** (`entityType = KB_NOTE`), `ResourceAcl` **[T]**
  (`resourceType = KB_SPACE`), `OutboxEvent` **[T]**, `AuditLog` **[T]**.
- Индексы: `uq_kb_spaces_org_slug`; `uq_kb_notes_space_path (space_id, path) WHERE deleted_at IS NULL`;
  `idx_kb_notes_search GIN (to_tsvector('simple', content_md))`;
  `idx_kb_notes_frontmatter GIN (frontmatter jsonb_path_ops)`;
  `idx_kb_links_source`, `idx_kb_links_target (…) WHERE target_note_id IS NOT NULL`,
  `idx_kb_links_broken (organization_id, target_title_raw) WHERE is_broken`;
  `uq_kb_note_tags`, `uq_kb_tags_org_space_name`; `idx_kb_import_jobs_org_status`.
- **Пробел модели:** у `KbSpace` нет поля `projectId?`, хотя permission-model описывает цепочку
  наследования `KbNote → KbSpace → Project → Organization`. Требуется добавить `KbSpace.projectId?`
  (и индекс `idx_kb_spaces_org_project`), иначе цепочка обрывается на пространстве.
- **Пробел модели:** у `KbSpace` нет признака личного пространства (`ownerId?` / `kind PERSONAL |
  TEAM | PROJECT`). ТЗ требует личные и командные пространства — требуется добавить, иначе «личная
  заметка разработчика» неотличима от командной.
- **Пробел модели:** нет сущности задания **экспорта** (есть только `KbImportJob`). Массовый экспорт
  пространства — длительная операция; требуется либо расширить `KbImportJob.kind` до
  `IMPORT | EXPORT`, либо завести `KbExportJob` **[T]**.
- `KbNote` версионирования не имеет сознательно: для `NATIVE`-пространств история фиксируется в
  `AuditLog`, для `GIT`/`OBSIDIAN_IMPORT` источник истории — `sourceCommitSha`.

## Права

- Ключи из каталога §3.7: `kb_space:read` (`VIEWER`), `kb_space:create`, `kb_space:update` (`MANAGER`),
  `kb_space:delete` (`MANAGER`, **dangerous**), `kb_space:manage_acl` (`MANAGER`, **dangerous**),
  `kb_space:sync_git` (`MANAGER`, **dangerous**), `kb_space:import` (`MANAGER`, **dangerous**),
  `kb_space:export` (`VIEWER`), `kb_note:read` (`VIEWER`), `kb_note:create` (`EDITOR`),
  `kb_note:update` (`EDITOR`), `kb_note:delete` (`EDITOR`), `kb_note:manage_tags` (`EDITOR`),
  `kb_note:view_graph` (`VIEWER`).
- Сопутствующие: `file:upload`/`file:read`/`file:download` (§3.8) для вложений;
  `comment:*` (§3.5) для обсуждения заметки; `acl:grant`/`acl:revoke` (§3.3); `job:read` (§3.18)
  для наблюдения за импортом.
- ACL-уровни и наследование: `KbNote → KbSpace → Project → Organization`. Личное пространство —
  владелец получает `MANAGER` без обхода цепочки. Граф и backlinks строятся **после** применения
  этих правил, а не фильтруются постфактум.
- Отсутствующих ключей нет (`kb_space:export` покрывает и экспорт заметок в пределах видимого).

## Зависимости / риски

- Зависит от: EPIC-015 (файлы и вложения заметок), EPIC-011 + EPIC-021 (модель прав и её применение),
  EPIC-014 (проект как узел цепочки), EPIC-020 (полиморфные комментарии/вложения),
  EPIC-007 (дизайн-система), EPIC-002 (проверка лицензий: CodeMirror 6 — MIT, Sigma.js/graphology — MIT).
- Блокирует: EPIC-024 (индексация заметок и пространств), EPIC-039 (AI по базе знаний, M8),
  EPIC-040 (материалы и онбординг, M8).
- Риски:
  - `R-09` — привязка к формату: закрывается тем, что источник правды — сам Markdown, плюс
    round-trip-тест как обязательная часть DoD.
  - `T-KNOW-01` — stored XSS: `rehype-sanitize` со строгой схемой **на рендере и на импорте**.
  - `T-KNOW-02` — path traversal при импорте: нормализация и Zod-валидация пути, серверный ключ S3.
  - `T-KNOW-03` — zip-bomb и гигантский импорт: лимиты, потоковая распаковка, отдельная очередь с
    ограниченной конкурентностью.
  - `T-KNOW-05` — граф раскрывает закрытое: фильтрация до построения графа.
  - `T-KNOW-07` — эксфильтрация через экспорт: аудит, лимиты, ограничение видимым подмножеством.
  - `R-08` — соблазн реализовать полноценную двустороннюю git-синхронизацию: вне скоупа 1.0.

## Ссылки

- Документация: [prd.md](../../docs/product/prd.md) (домен ТЗ 5, R-09) ·
  [roadmap.md → M4](../../docs/product/roadmap.md#m4--знания) ·
  [data-model.md §5](../../docs/architecture/data-model.md) ·
  [ux-architecture.md → Заметка KB + граф](../../docs/architecture/ux-architecture.md) ·
  [stack.md](../../docs/architecture/stack.md) ·
  [permission-model.md §3.7, «Наследование ACL»](../../docs/security/permission-model.md) ·
  [threat-model.md `T-KNOW-01…07`](../../docs/security/threat-model.md)
- Правила: `rules/editor-content.mdc`, `rules/import-export.mdc`, `rules/permissions.mdc`
  (каталог `rules/` пока пуст — файлы создаются при старте M4)

## Истории

_Будут созданы на kickoff M4 через `/pm epic knowledge-base`._
