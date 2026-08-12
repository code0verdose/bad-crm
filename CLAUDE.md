# Project guidance for Claude — Bad CRM

## Что это за проект

**Bad CRM** — self-hosted multi-tenant open-source CRM/workspace для команд разработки (5–50 человек).
Заменяет связку Jira + Notion + Obsidian + Slack + 1Password + Toggl одним инструментом с единой моделью
данных, единой моделью прав и полным контролем над данными. Домены: проекты, канбан-задачи,
Notion-подобные документы, Obsidian-подобная база знаний, файлы, тайм-трекинг, дашборды, Slack-подобный
чат, E2EE-хранилище паролей, защищённые ссылки, GitHub Actions, AI-ассистент, онбординг, проектное
лидерство (клиенты, контракты, инвойсы, звонки).

**Лицензия:** AGPL-3.0-or-later. **Языки интерфейса:** EN и RU (равноправные).
**Модель поставки:** `docker compose up` на одном хосте; SaaS-версии нет.

### Текущее состояние — M1 закрыт, M2 наполовину

Спецификация завершена (фаза 0). **Эпики EPIC-001…EPIC-012 — в статусе `review`**: вся M1 и первая
половина M2. Статус эпика при этом не означает, что все его истории в `review`: внутри EPIC-011
STORY-011-07 (policy-слой) в `in-progress`, а STORY-011-06 в `backlog`. Состояние историй сверяй по
frontmatter, а не по статусу эпика:

```bash
grep -h '^status:' epics/epic-011-*/stories/*.md | sort | uniq -c
```

E2E-харнесс работает и проверен в CI — джоба `end-to-end` (job id `e2e` в `ci.yml`) собирает
установку целиком и гоняет сценарии входа, выхода, доступности, языков и изоляции арендаторов.
Сколько их сейчас **закоммичено** — печатает `pnpm --filter @bad-crm/e2e exec playwright test --list`;
файл, лежащий в рабочем дереве, но не в индексе, в CI не попадает и в счёт не идёт.

**EPIC-011 закрыт по составу с одним исключением:** STORY-011-06 (ACL на ресурс) помечена
`blocked: true` с записанной причиной — ACL это доступ *к ресурсу*, а первым доменом с наследованием
станет проект (EPIC-014). Три критерия STORY-012-07 (команда как субъект ACL) отложены по той же
причине и **заглушек не получили**.

Дальше по [roadmap](docs/product/roadmap.md): EPIC-013 (2FA) — **в работе**, затем EPIC-014
(проекты, он же разблокирует ACL), EPIC-015 (файлы), EPIC-016 (журнал действий), EPIC-017
(self-host alpha). Актуальный борд — [`epics/README.md`](epics/README.md) (генерируется из
frontmatter); его колонка прогресса считает истории в статусе `done`, а `review` не считает, поэтому
она занижена относительно фактической готовности — смотри статусы эпиков и историй, а не проценты.

Про EPIC-007 стоит знать две вещи, чтобы не искать в нём недоделку. Пять критериев приёмки из восьми
были выполнены попутно в EPIC-004 и EPIC-006 — это установлено сверкой с кодом, а не с бордом.
Седьмой («экран с данными использует `DataState`») закрыт EPIC-012: `DataState` стоит на профиле
сотрудника, на справочнике и на матрице ролей. Восьмой («ловушка фокуса в модалке») **не закрыт**:
модалок в продукте уже больше двух — к диалогу офбординга (EPIC-012) и `role-matrix-preview-modal`
добавились `permission-override-dialog`, `team-create-dialog` и `team-delete-dialog`, а тест,
который считался доказательством закрытия (`packages/client/test/widgets/role-matrix-preview-modal.test.tsx`),
лежит в рабочем дереве и **не закоммичен**. Актуальный список модалок:

```bash
git ls-files 'packages/client/src/**' | grep -iE 'modal|dialog'
```

Урок из того теста сохраняется и распространяется на остальные: он монтирует экран целиком, а не
компонент, потому что возврат фокуса идёт на **триггер**, а триггер в момент открытия `disabled` —
стенд с обычной кнопкой доказал бы не то, что продукт отгружает.

Числа по артефактам здесь намеренно не записаны: они устаревают на следующем коммите. Каждое
печатает своя команда.

| Артефакт | Где | Чем посчитать |
|---|---|---|
| Продуктовые и архитектурные документы | `docs/` | `find docs -type f -not -path 'docs/brain/*' \| wc -l` |
| ADR | `docs/architecture/adr/` | `ls docs/architecture/adr/*.md \| wc -l` |
| Правила разработки | `rules/` | `ls rules/*.mdc \| wc -l` |
| Проектные агенты-ревьюеры | `.claude/agents/` | `ls .claude/agents/*.md \| wc -l` |
| Эпики | `epics/` | `find epics -name epic.md \| wc -l` |
| Пользовательские истории | `epics/*/stories/` | `find epics -path '*/stories/*.md' \| wc -l` |
| Истории M1–M2 (без EPIC-047/048/049) | `epics/*/stories/` | `find epics -path '*/stories/*.md' \| grep -vE 'epic-04[789]' \| wc -l` |

**Что уже работает:**

- **EPIC-001** — монорепо pnpm + turborepo с четырьмя пакетами, `tsconfig.base.json` strict и project
  references, ESLint 9 flat config с архитектурными запретами, Prettier, husky + lint-staged +
  commitlint, `docker-compose.yml` (postgres+pgvector, redis, minio, meilisearch, mailpit),
  `.env.example` + zod-схемы окружения (сервер и клиент раздельно), наполненный `packages/shared`
  (zod-примитивы, branded id, каталог permissions, коды ошибок), preflight в `pnpm dev`.
- **EPIC-002** — CI в `.github/workflows/`: `ci.yml` (джобы `checks`, `scan`, `integration`,
  `e2e` — он же `end-to-end` по имени, `compat`), `codeql.yml`,
  `dependency-review.yml`, `license-check.yml`, `pr-conventions.yml`; dependabot, шаблоны PR и issue.
- **EPIC-003** — Express 5 по гексагональным слоям, `/health` и `/ready`, `/api/v1/meta`,
  error-handler с `problem+json`, CSP и HTTP-hardening, `prisma/schema.prisma` и первая миграция
  (`20260727120000_init_tenancy_and_rls`) с RLS-политиками, `docs/api/openapi.yaml` и генерация
  типов клиента.
- **EPIC-004** — Vite + React 19, слои FSD с линтом направления
  зависимостей, Mantine 9 + тема + семантические токены `--bc-*`, TanStack Query с фабрикой ключей и
  optimistic-хелперами, типизированный клиент `openapi-fetch` с auth- и idempotency-middleware,
  TanStack Router с файловыми маршрутами, гардами и границами состояний, оболочка приложения
  (сайдбар, шапка, хлебные крошки, skip-link, объявление смены маршрута).
- **EPIC-005** — мультиарендность на RLS: роли БД (`app_migrator`, `app_user`, `app_auth`,
  `app_auth_definer`, `backup_role`) из `prisma/sql/00-bootstrap-roles.sql`, канонические политики с
  `USING`+`WITH CHECK` и `FORCE RLS`, `withTenant`/`guardedClient`, isolation-тесты с положительным
  контролем на реальном Postgres через Testcontainers.
- **EPIC-006** — аутентификация: регистрация организации с владельцем, вход, ротация refresh-токена
  с обнаружением повторного использования (отзыв всего семейства), выход, список сессий и их отзыв,
  смена пароля, восстановление по письму (экраны `/forgot-password` и `/reset-password/$token`).
  Пароли — argon2id; access-токен 15 минут только в памяти, refresh — opaque в httpOnly cookie,
  в БД только SHA-256. Резолв учётной записи до того, как известна организация — узкие
  `SECURITY DEFINER` функции `auth_lookup_*` во владении роли `app_auth_definer` без права
  подключения (`auth_lookup_user`, `auth_lookup_users_by_email`, `auth_lookup_session`,
  `auth_lookup_password_reset`, `auth_lookup_invitation`; список растёт вместе с резолверами —
  актуальный печатает `grep -rho 'auth_lookup_[a-z_]*' packages/server/prisma/ | sort -u`). Ограничитель частоты на Redis, fail-closed. Почта — nodemailer, отправка после
  коммита транзакции; при `SMTP_URL` без `MAIL_FROM` почта отключается с предупреждением, а не
  роняет старт. `organizations.owner_id` обязателен на уровне схемы: организация и её владелец
  пишутся **одним оператором** (ключ циклический, а FK в PostgreSQL исполняются по завершении
  оператора), оба действия ключа — `NO ACTION`, а офбординг владельца без передачи владения
  отвергается политикой с кодом `last_owner_required`.
- **EPIC-007** — дизайн-система: токены обеих схем с автопроверкой контраста по парам,
  `shared/ui` (`DataState`, скелетоны, `PageHeader`, `Section`, `SplitPane`, `PaginationBar`,
  `FilterBar`, тостер), axe на входе и оболочке, архитектурный тест «`shared/ui` не знает доменов и
  не ходит в сеть», stylelint против литеральных значений.

- **EPIC-008** — двуязычность: одинаковый набор namespace в `en` и `ru`
  (`ls packages/client/src/shared/i18n/locales/en`), переключатель языка в оболочке и на
  публичных экранах (`widgets/public-screen`), определение языка «профиль → браузер → английский»,
  **все** коды ошибок и коды проблем поля переведены и закрыты гейтом
  (`packages/client/test/i18n/error-codes-parity.test.ts` — он перебирает `ERROR_CODES` и
  `VALIDATION_ISSUE_CODES` целиком, поэтому число кодов нигде не записано и не может разойтись;
  сам каталог собирается как `GENERIC_ERROR_CODE_STATUS` плюс `ERROR_RESOURCES × {not_found,
  forbidden, already_exists}` в `packages/shared/src/errors/error-code.enums.ts`), тостер переводит
  и интерполирует, форматирование дат,
  чисел, денег, длительностей и списков через `Intl` в `shared/lib/format` с запретом `Intl.*` мимо
  обёрток, `pnpm i18n:check` со сводкой в CI, `i18next/no-literal-string` и псевдолокаль.

- **EPIC-009** — наблюдаемость: структурные логи pino с `redact` по путям, `requestId`/
  `organizationId`/`userId` в каждой записи, метрики, health и readiness. Тело запроса и URL не
  логируются **ни на каком уровне**: URL защищённой ссылки сам является учётными данными.
- **EPIC-010** — E2E-харнесс на Playwright поверх поднятого стека, `axe` в каждом прогоне. В CI
  гоняется то, что закоммичено (`pnpm --filter @bad-crm/e2e exec playwright test --list`).
- **EPIC-011** — права: закрытый каталог из 331 ключа (111 опасных), семь системных ролей, кастомные
  роли с правилом subset, персональные исключения ALLOW/DENY, снапшот матрицы роль × endpoint,
  чтение чужих эффективных прав с источником каждого (`GET /users/{userId}/permissions`, право
  `permission:override_read`, чтение пишется в аудит). Лестница вычисления capability — **одна**, в
  `packages/shared`; серверные обёртки её транслируют, клиент копирует источник, а не пересчитывает.
- **EPIC-012** — люди: приглашения со сроком и повторной выдачей, принятие с созданием учётной
  записи, профиль сотрудника, справочник с фильтрами в URL, офбординг одной транзакцией (статус,
  версия прав и все семьи сессий разом; правило ранга в обе стороны), передача владения (только
  действующий владелец, гонка закрыта условной записью корня), команды с составом и ролью `LEAD`.

**Чего ещё нет:** ACL на объект (STORY-011-06, заблокирована до EPIC-014) — персональные оверрайды
прав (STORY-011-05) реализованы, запись и чтение чужих эффективных прав существуют
(`GET /api/v1/users/{userId}/permissions`, STORY-011-11), а ресурсного слоя пока нет ни у одного
домена; переключателя организации и юнита `units/organization`; привязки `errors[].path` к полям
формы (STORY-008-03 — нечем проверить, пока клиент и сервер валидируют одной схемой); мастерской
компонентов (STORY-008-06 — нужен выбор инструмента и ADR; псевдолокаль при этом сделана); доменных
юнитов (задачи, документы, время — M3+).

**Следствие для любой работы в этом репозитории:** проверяй по факту, а не по этому списку — он
устаревает быстрее кода. Не утверждай «работает», не запустив.

---

## 🔴 ТРИ НЕПРИКОСНОВЕННЫХ ИНВАРИАНТА

Эти три правила не обсуждаются, не откладываются «на потом» и не отключаются ради скорости.
Нарушение любого — блокирующий дефект, а не замечание. Все три объединяет одно свойство: **ошибка
не проявляется функционально** — приложение работает, тесты зелёные, данные утекают.

### 1. Мультиарендность: нет таблицы без `organizationId` и RLS

Любая новая таблица с данными арендатора обязана иметь:

- колонку `organization_id` (NOT NULL, первой колонкой составных индексов);
- `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` **и** `FORCE ROW LEVEL SECURITY` (без `FORCE` владелец
  таблицы обходит политику молча);
- каноническую политику с **обоими** предикатами — `USING` (что видно на чтение) **и** `WITH CHECK`
  (что разрешено записать); только `USING` означает, что можно записать строку в чужой тенант;
- политику на роль `app_user`, а не на `PUBLIC`;
- явные `GRANT` (никаких `ALTER DEFAULT PRIVILEGES`);
- составные внешние ключи (проверки FK обходят RLS);
- **isolation-тест с положительным контролем**: тест обязан доказать не только что чужая строка не
  видна, но и что своя — видна. Тест без положительного контроля проходит и на сломанном соединении.

Роль приложения не имеет `BYPASSRLS`. Обращение к БД идёт только через `withTenant(...)`; предохранитель
`guardedClient` роняет запрос вне tenant-контекста. Норматив — [`docs/security/rls-design.md`](docs/security/rls-design.md),
чек-лист «новая таблица» — там же. Гейт — агент `tenancy-rls-auditor`.

### 2. Права: каждый endpoint объявляет permission и проверяет её в use-case

- Право берётся из закрытого каталога `packages/shared/src/permissions/permissions.catalog.ts` —
  новых строковых литералов «по месту» не существует.
- **Проверка живёт в use-case (через policy из `domain`), а не только в middleware.** Middleware —
  первый фильтр, не источник истины. Вторая точка вычисления прав (`if (user.role === 'admin')` в
  контроллере, разбор permissions на клиенте, фильтрация «постфактум» в сервисе) — уничтожает модель
  прав; это риск R-15 из PRD.
- Итоговое решение = конъюнкция capability (роль + per-user override) и resource ACL.
- Отсутствие доступа к чужой организации отдаётся как **404**, а не 403 — иначе API становится
  оракулом существования сущностей. 403 — только внутри своей организации.
- Списочные endpoint'ы фильтруют в SQL, а не после выборки.
- Клиентская проверка права — только подсказка для UI; авторитет всегда на сервере.

Норматив — [`docs/security/permission-model.md`](docs/security/permission-model.md). Гейт — агент
`permission-matrix-auditor`.

### 3. E2EE-vault: расшифрованное не покидает браузер

Ничего расшифрованного из хранилища секретов не уходит **на сервер, в логи, в телеметрию, в поисковый
индекс и в контекст AI**. Конкретно запрещено:

- отправлять на сервер открытый текст секрета, мастер-пароль, приватный ключ, любой производный ключ;
- писать ключевой материал в `localStorage`, `sessionStorage`, IndexedDB, cookie, в состояние роутера,
  в query-кеш, в URL;
- логировать (включая `console.log` в dev), отправлять в Sentry/OTel, класть в audit log;
- индексировать в Meilisearch или pgvector (для vault-сущностей не создаются `EmbeddingChunk`,
  `VAULT_ITEM` отсутствует в allow-list RAG-ретривера);
- передавать в AI-ассистента и во внешнего агента по MCP.

  **Это требование к будущему коду, а не описание существующего.** Ни контекста `ai`, ни адаптера
  `presentation/mcp/**`, ни архитектурного теста на запрет импорта между ними и `vault` в
  репозитории пока нет — vault, ассистент и MCP относятся к M4+ (EPIC-048). Эпик, который заводит
  первый из этих контекстов, обязан в том же коммите завести и запрет импорта в
  `packages/server/test/unit/architecture/layers.test.ts` — одним тестом на оба канала, иначе
  инвариант будет выполняться только для одного из них.

Сервер хранит только шифротекст и метаданные. Дополнительно: nonce не переиспользуется, AAD
обязателен, downgrade параметров Argon2id/шифра отвергается клиентом, отзыв доступа всегда
сопровождается ротацией ключа.

Норматив — [`docs/security/e2ee-design.md`](docs/security/e2ee-design.md), раздел «Правила для
разработчиков» (там **сомнение равно FAIL**). Гейт — агент `e2ee-crypto-reviewer`, обязателен на
каждое касание vault/крипто-кода.

---

## Порядок источников истины

Три слоя, всегда в этом порядке:

1. **`docs/`** — источник истины: продукт, архитектура, модель данных, безопасность, ADR.
2. **`epics/`** — execution: что именно делаем сейчас, в каком объёме, с какими критериями приёмки.
3. **Код** — реализация.

**При конфликте между слоями — эскалировать пользователю, не выбирать молча.** Типичные конфликты:
история требует поля, которого нет в `data-model.md`; ADR противоречит правилу в `rules/`; код
разошёлся со спекой. Правильная реакция — остановиться, показать оба источника и спросить; неправильная —
«поправить как удобнее» и пойти дальше.

Внутри `docs/` источники истины разделены (см. [`docs/README.md`](docs/README.md)):

- **имена сущностей, таблиц, полей** → [`docs/architecture/data-model.md`](docs/architecture/data-model.md);
- **права и роли** → [`docs/security/permission-model.md`](docs/security/permission-model.md);
- **криптография и vault** → [`docs/security/e2ee-design.md`](docs/security/e2ee-design.md);
- **контракт API** → [`docs/api/openapi.yaml`](docs/api/openapi.yaml);
- **термины домена (ubiquitous language)** → [`docs/product/glossary.md`](docs/product/glossary.md).

---

## Обязательное правило: CI-before-push

**Перед каждым `git push`:**

```bash
pnpm turbo run typecheck lint build test
pnpm coverage:baseline
```

Все задачи на всех пакетах должны быть зелёные. Красный или непрогнанный пайплайн — push запрещён.
`build` ≠ `typecheck`: они расходятся (проектные ссылки и emit), прогоняй оба явно.
`coverage:baseline` — вторая обязательная команда: она сравнивает покрытие с
`coverage-baseline.json` и падает на просадке больше 0.5 п.п. Зелёный `test` этого не ловит —
пороги в конфигах задают нижнюю границу по слою, а базовая линия означает «не хуже, чем было»
(типовая причина просадки — код, покрытый только интеграционным набором, которого в замере нет).

Интеграционный набор локально — `pnpm test:integration:local`: он спрашивает у Docker его endpoint
и выставляет `DOCKER_HOST`/`TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE`. Без этого на Colima и любом
rootless-демоне Testcontainers отвечает «Could not find a working container runtime strategy».
Норматив — [`rules/ci-before-push.mdc`](rules/ci-before-push.mdc).

Команда существует начиная с EPIC-001.

---

## Какой файл читать когда

### Документация (`docs/`)

| Файл | О чём | Обязательно при… |
|---|---|---|
| [`docs/README.md`](docs/README.md) | Map of Docs: карта всей документации и связей | начале работы в незнакомой области |
| [`docs/product/prd.md`](docs/product/prd.md) | Проблема, персоны/JTBD, скоуп MoSCoW, NSM и метрики, NFR-1…NFR-12, риски R-01…R-18 | обсуждении скоупа, спорах «делаем ли мы это» |
| [`docs/product/roadmap.md`](docs/product/roadmap.md) | Майлстоуны M1–M9, состав эпиков, критерии выхода | выборе следующего эпика, планировании |
| [`docs/product/glossary.md`](docs/product/glossary.md) | Ubiquitous language EN/RU; термин = имя модели и unit'а | введении любой новой сущности или unit'а |
| [`docs/architecture/overview.md`](docs/architecture/overview.md) | C4 1–3, bounded contexts, сквозные механизмы, развёртывание | проектировании нового домена, изменении границ |
| [`docs/architecture/stack.md`](docs/architecture/stack.md) | Стек и версии, гексагональные слои, контракт API, БД, outbox, env, команды | любой серверной работе |
| [`docs/architecture/data-model.md`](docs/architecture/data-model.md) | Сущности, таблицы, индексы, RLS-политики — **источник истины по именам** | любом изменении схемы или Prisma-модели |
| [`docs/architecture/ux-architecture.md`](docs/architecture/ux-architecture.md) | Принципы UI, маршруты, экраны, дизайн-система, a11y, i18n, FSD клиента | любой клиентской работе |
| [`docs/architecture/adr/`](docs/architecture/adr/) | 26 ADR: по одному решению на файл, с отвергнутыми альтернативами | попытке изменить принятое решение — сперва прочти ADR |
| [`docs/security/threat-model.md`](docs/security/threat-model.md) | STRIDE по контекстам, нарушители N1–N10, топ-15 угроз, каналы MCP и почты, остаточные риски | работе с любым чувствительным потоком данных |
| [`docs/security/permission-model.md`](docs/security/permission-model.md) | Пять слоёв прав, `effectivePermission`, матрица роль × endpoint | добавлении endpoint'а, права или роли |
| [`docs/security/rls-design.md`](docs/security/rls-design.md) | Роли БД, канонический шаблон политики, `withTenant`, isolation-тесты | добавлении таблицы, миграции, репозитория, job'а |
| [`docs/security/e2ee-design.md`](docs/security/e2ee-design.md) | Иерархия ключей, примитивы, жизненный цикл, blind index, защищённые ссылки | любом касании vault, крипто, secure links |
| [`docs/api/README.md`](docs/api/README.md) | Contract-first: зачем, как генерируются типы, как менять контракт | изменении API |
| [`docs/runbooks/install.md`](docs/runbooks/install.md) | Установка self-host, env, первый вход, чек-лист безопасности | вопросах установки, изменении compose/env |
| [`docs/runbooks/upgrade.md`](docs/runbooks/upgrade.md) | Обновление, expand→migrate→contract, новые env, откат | выпуске релиза, любой миграции |
| [`docs/runbooks/backup-restore.md`](docs/runbooks/backup-restore.md) | Что бэкапим, `FORCE RLS` и `pg_dump`, RPO/RTO, восстановление | изменении схемы хранения, инцидентах |
| [`docs/runbooks/incident.md`](docs/runbooks/incident.md) | Утечка, компрометация `APP_ENCRYPTION_KEY`/учётки, presigned URL, отказ | любом инциденте безопасности |

### Правила (`rules/*.mdc`)

`alwaysApply: true` — применяются всегда, без напоминания. Остальные — по области изменений (`globs`).

| Правило | О чём | Обязательно при… |
|---|---|---|
| [`rules/tdd-and-commit-gate.mdc`](rules/tdd-and-commit-gate.mdc) | Red→Green→Refactor и проверки commit-гейта | **всегда** |
| [`rules/ci-before-push.mdc`](rules/ci-before-push.mdc) | Полный набор проверок до push | **всегда** |
| [`rules/commit-hygiene.mdc`](rules/commit-hygiene.mdc) | Что никогда не попадает в git | **всегда** |
| [`rules/epic-driven-development.mdc`](rules/epic-driven-development.mdc) | Нет кода без активного эпика и истории | **всегда** |
| [`rules/agent-orchestration.mdc`](rules/agent-orchestration.mdc) | Лимиты параллелизма, обязательная сверка судьёй | **всегда** |
| [`rules/naming-and-structure.mdc`](rules/naming-and-structure.mdc) | Имена файлов и символов, одна ответственность на файл | **всегда** (client и server) |
| [`rules/tenancy-rls.mdc`](rules/tenancy-rls.mdc) | Инвариант №1: `organizationId`, RLS, `withTenant` | **всегда** на сервере |
| [`rules/permissions.mdc`](rules/permissions.mdc) | Инвариант №2: каталог прав, проверка в use-case | **всегда** там, где есть доступ |
| [`rules/security.mdc`](rules/security.mdc) | Auth, сессии, секреты, env, HTTP-hardening, rate limit | **всегда** на сервере |
| [`rules/i18n.mdc`](rules/i18n.mdc) | EN+RU обязательны, ноль хардкод-строк | **всегда**, где есть текст |
| [`rules/a11y.mdc`](rules/a11y.mdc) | WCAG 2.1 AA, фокус, клавиатурный DnD, ARIA live | **всегда** в интерактивном UI |
| [`rules/frontend-fsd.mdc`](rules/frontend-fsd.mdc) | Слои FSD, barrels, алиасы, цепочка ui→service→api | **всегда** в `packages/client/src` |
| [`rules/hexagonal-backend.mdc`](rules/hexagonal-backend.mdc) | Что живёт в каком слое и куда смотрят зависимости | **всегда** в `packages/server/src` |
| [`rules/testing.mdc`](rules/testing.mdc) | Что тестируем на каком уровне, пороги покрытия | **всегда** при написании тестов |
| [`rules/e2ee-crypto.mdc`](rules/e2ee-crypto.mdc) | Инвариант №3: нулевая терпимость в крипто | касании vault, secure links, мастер-пароля |
| [`rules/db-migrations.mdc`](rules/db-migrations.mdc) | expand→migrate→contract, без блокирующего DDL | правке `prisma/schema.prisma` или миграций |
| [`rules/api-contract.mdc`](rules/api-contract.mdc) | Contract-first, спека — договор | добавлении/изменении endpoint'а или кода ошибки |
| [`rules/zod-validation.mdc`](rules/zod-validation.mdc) | Schema-first, парсинг на границах, тип из схемы | написании любой валидации |
| [`rules/tanstack-query.mdc`](rules/tanstack-query.mdc) | Query keys, кеш, optimistic vs pessimistic, отмена | любом фетче или мутации на клиенте |
| [`rules/lists-and-filters.mdc`](rules/lists-and-filters.mdc) | URL — единственный источник правды фильтров | любом фильтруемом/пагинируемом экране |
| [`rules/design-system.mdc`](rules/design-system.mdc) | Mantine 9, токены, CSS Modules, когда заводить свой компонент | вёрстке любого UI |
| [`rules/errors-and-toasts.mdc`](rules/errors-and-toasts.mdc) | Один сигнал на действие, без дублей тостов | показе ошибок, успеха, loading |
| [`rules/realtime.mdc`](rules/realtime.mdc) | Комнаты строит сервер, проверка прав перед каждым emit | работе с Socket.IO, presence, typing |
| [`rules/outbox.mdc`](rules/outbox.mdc) | Событие в той же транзакции, идемпотентные обработчики | любом побочном эффекте вне транзакции |
| [`rules/search-index.mdc`](rules/search-index.mdc) | Права внутри документа индекса, vault не индексируется | индексации в Meilisearch/pgvector |
| [`rules/file-uploads.mdc`](rules/file-uploads.mdc) | Проверка прав до presigned URL, короткий TTL, MIME allow-list | работе с файлами |
| [`rules/observability.mdc`](rules/observability.mdc) | requestId/organizationId/userId, ноль секретов в логах | логировании, метриках, аудите |
| [`rules/polymorphic-access.mdc`](rules/polymorphic-access.mdc) | Целостность и права для пар `(entityType, entityId)` | комментариях, вложениях, ACL, эмбеддингах |
| [`rules/editor-content.mdc`](rules/editor-content.mdc) | Формат хранения, санитизация, версионирование контента | документах, KB, комментариях, сообщениях |
| [`rules/time-tracking-invariants.mdc`](rules/time-tracking-invariants.mdc) | Один активный таймер на уровне БД, approved неизменяем | учёте времени и таймшитах |
| [`rules/ai-providers.mdc`](rules/ai-providers.mdc) | Ключи в БД зашифрованы, permission-aware retrieval, prompt injection | работе с AI-провайдерами и ассистентом |
| [`rules/import-export.mdc`](rules/import-export.mdc) | Недоверенный вход, вывод в границах прав, фоновые job'ы | импорте/экспорте данных |
| [`rules/self-host-packaging.mdc`](rules/self-host-packaging.mdc) | Не ломать инсталляции, которых не видишь | правке compose, env, профилей, стартовых проверок |
| [`rules/dependencies.mdc`](rules/dependencies.mdc) | Latest stable, supply-chain, лицензии совместимы с AGPL-3.0 | добавлении или апгрейде любого пакета |

---

## Стек

Полная таблица с обоснованиями — [`docs/architecture/stack.md`](docs/architecture/stack.md).

| Слой | Технология | Версия | ADR |
|---|---|---|---|
| Монорепо | pnpm workspaces + turborepo | pnpm 9+, turbo 2+ | [ADR-0001](docs/architecture/adr/0001-monorepo-pnpm-turborepo.md) |
| Язык / рантайм | TypeScript strict / Node.js LTS | 5.9.3 (пин, одна версия на воркспейс) / `>=22.22.2`, без верхней границы | [ADR-0001](docs/architecture/adr/0001-monorepo-pnpm-turborepo.md), [ADR-0022](docs/architecture/adr/0022-typescript-version-policy.md) |
| HTTP + архитектура сервера | Express 5 + hexagonal (ports & adapters) | 5.x | [ADR-0002](docs/architecture/adr/0002-hexagonal-backend-express-prisma.md) |
| БД | PostgreSQL + pgvector | 16 / 0.7+ | [ADR-0004](docs/architecture/adr/0004-multi-tenancy-postgres-rls.md) |
| ORM | Prisma | 5.x/6.x | [ADR-0002](docs/architecture/adr/0002-hexagonal-backend-express-prisma.md) |
| Контракт API | OpenAPI 3.1 + `openapi-typescript` | 3.1 / 7.x | [ADR-0003](docs/architecture/adr/0003-openapi-as-source-of-truth.md) |
| Валидация | zod | 4.x | — |
| Клиент | React + Vite + FSD «units» | 19 | [ADR-0005](docs/architecture/adr/0005-fsd-units-frontend-architecture.md) |
| UI-kit и стили | Mantine + CSS Modules (без Tailwind) | 9.x | [ADR-0006](docs/architecture/adr/0006-mantine-css-modules-no-tailwind.md) |
| Роутинг и дата-слой | TanStack Router + TanStack Query | v5 | [ADR-0007](docs/architecture/adr/0007-tanstack-router-and-query.md) |
| Клиентское состояние (не серверное) | zustand — только то, что не помещается в Query и в URL | 5.x | [ADR-0026](docs/architecture/adr/0026-client-state-zustand.md) |
| Права | RBAC + per-user overrides + resource ACL | — | [ADR-0008](docs/architecture/adr/0008-permission-model-rbac-plus-acl.md) |
| Крипто клиента | `libsodium-wrappers-sumo` (Argon2id, XChaCha20-Poly1305, Ed25519) | — | [ADR-0009](docs/architecture/adr/0009-e2ee-vault-key-hierarchy.md) |
| Realtime | Socket.IO + `@socket.io/redis-streams-adapter` | 4.x | [ADR-0010](docs/architecture/adr/0010-realtime-socketio-redis-adapter.md) |
| Поиск | Meilisearch (опционален; fallback — postgres-fts) | 1.x | [ADR-0011](docs/architecture/adr/0011-meilisearch-permission-aware-search.md) |
| Редактор документов | BlockNote (JSON-контент) | — | [ADR-0012](docs/architecture/adr/0012-docs-editor-blocknote-json-content.md) |
| База знаний | Markdown как source of truth | — | [ADR-0013](docs/architecture/adr/0013-kb-markdown-source-of-truth.md) |
| AI | абстракция провайдера (anthropic / openai / openai_compat / openrouter) | — | [ADR-0014](docs/architecture/adr/0014-ai-provider-abstraction.md) |
| Файлы | S3-совместимое хранилище (MinIO) + presigned URL | AWS SDK 3.x | [ADR-0015](docs/architecture/adr/0015-s3-file-storage-presigned-urls.md) |
| Время | единая модель записи времени | — | [ADR-0016](docs/architecture/adr/0016-time-tracking-single-entry-model.md) |
| Графики | Mantine Charts | — | [ADR-0017](docs/architecture/adr/0017-charts-mantine-charts.md) |
| Лицензия | AGPL-3.0-or-later | — | [ADR-0018](docs/architecture/adr/0018-license-agpl-3.md) |
| i18n | i18next, EN + RU | — | [ADR-0019](docs/architecture/adr/0019-i18n-en-ru-i18next.md) |
| Поставка | Docker Compose, профили `minimal`/`default`/`scaled` | — | [ADR-0020](docs/architecture/adr/0020-self-host-packaging-docker.md) |
| События и очереди | transactional outbox + BullMQ + Redis | 5.x / 7.x | [ADR-0021](docs/architecture/adr/0021-transactional-outbox.md) |
| Версия TypeScript | одна на весь воркспейс, точный пин | 5.9.3 | [ADR-0022](docs/architecture/adr/0022-typescript-version-policy.md) |
| Тесты | Vitest, supertest, Testcontainers, Playwright, RTL | latest | — |

Отдельно: `@node-rs/argon2` (argon2id для паролей), pino 9 (логи), nodemailer (почта), helmet/cors/
`rate-limiter-flexible` (HTTP-hardening). Лицензии — только AGPL-совместимые; `license-checker`
с allow-list ломает сборку на новой лицензии.

---

## Workflow эпиков

Полные правила — [`rules/epic-driven-development.mdc`](rules/epic-driven-development.mdc).

**Статусы:** `backlog → ready → in-progress → review → done`. `blocked` — **отдельный флаг**
(`blocked: true` во frontmatter), а не статус: заблокированная история сохраняет свой статус.

**Правила:**

1. **Нет кода без активного эпика и истории.** Один эпик в работе за раз.
2. Переход в `review` и `done` — **только на зелёном commit-гейте** (вся таблица проверок ниже).
3. Эпик берётся из [`docs/product/roadmap.md`](docs/product/roadmap.md) по порядку майлстоунов:
   слой прав идёт до доменов, крипто-фундамент — до vault, трекинг времени — до аналитики.
4. Если `docs/` неверен — сперва правится `docs/`, потом код. Молча расходиться нельзя.
5. Архитектурное решение, принятое по ходу, фиксируется новым ADR в `docs/architecture/adr/`.
6. Майлстоун закрывается целиком по критерию выхода; недоделки не переносятся «хвостом» (риск R-08).

**Борд эпиков** (`epics/README.md`) — генерируемый файл: таблица ID · эпик · статус · milestone ·
прогресс. Собирается скриптом `~/.claude/skills/pm/sync-board.sh`; руками не правится. В таблице —
все эпики репозитория; расхождение числа строк с `find epics -name epic.md | wc -l` означает, что
борд не пересобирали.

**Истории M3–M9 не написаны намеренно.** Написаны истории M1–M2; исключения — EPIC-047 (лендинг),
EPIC-048 (MCP) и EPIC-049 (корпоративная почта), спроектированные по отдельным запросам; MCP и почта
пересматриваются на kickoff своего майлстоуна. Сколько историй где — см. таблицу «Артефакт» выше и
борд `epics/README.md`; здесь чисел нет намеренно, они расходятся с репозиторием быстрее всего. Истории следующего
майлстоуна создаются на его kickoff командой `/pm epic <тема>` — писать их за полгода до реализации
значит переписывать их дважды.

---

## Commit-гейт

**Не делать `git commit` и `git push`, пока не пройдена каждая строка таблицы ниже** — даже если
пользователь уже попросил закоммитить. Сначала гейт, потом коммит. Коммит и push — только по явной
просьбе. Источник истины по составу гейта — эта таблица и `rules/tdd-and-commit-gate.mdc`; они
обязаны совпадать построчно, поэтому число проверок в прозе не дублируется.

| # | Проверка | Чем |
|---|---|---|
| 1 | Тесты и покрытие изменённого кода (строки + ветки), TDD соблюдён | агент `test-coverage` |
| 2 | Безопасность: нет находок High/Critical, секретов, уязвимых зависимостей | агент `security-auditor` |
| 3 | База данных: схема, миграции, запросы, риск потери данных, rolling-совместимость | агент `db-reviewer` (если дельта трогает БД) |
| 4 | Продакшен-готовность: ошибки, логи, конфиг, перформанс, откат | агент `production-readiness` |
| 5 | Чистота коммита: нет fallback-ов, тестовых данных, отладки, временных скриптов | `scan-cruft.sh --staged` + агент `commit-hygiene` |
| 6 | База знаний обновлена: `docs/brain/` + общий vault | правило «двойное объяснение», часть B |
| 7 | Утверждения соответствуют коду: обоснования рисков, комментарии, спека, разделы «Сделано»/«Отложено» | агент `stale-claims-auditor` (обязателен, если над дельтой работали две и более волны) |

Прогон одной командой — скилл **`/gate`**. Любой FAIL/BLOCKED — коммит откладывается, находки
показываются, чинится по TDD (сперва тест), перезапускаются только затронутые проверки.

**Плюс проектные гейты** (см. таблицу агентов ниже): дельта, задевающая RLS, права, vault, контракт,
realtime, поиск, i18n, FSD или обновляемость, обязана пройти соответствующего агента.

### Сообщения коммитов — Conventional Commits, на английском

```
<type>(<scope>): <subject>

<body>

<footer>
```

- `type`: `feat` | `fix` | `docs` | `style` | `refactor` | `perf` | `test` | `build` | `ci` | `chore` | `revert`.
- `subject`: imperative mood, lowercase, без точки, ≤ 50 символов.
- Один коммит = одно логическое изменение.
- **Без `Co-Authored-By: Claude`, без «🤖 Generated with Claude Code», без любых упоминаний
  Claude/AI** — и в сообщении коммита, и в описании PR.
- Если на дефолтной ветке — сперва создать ветку.

Примеры: `feat(vault): add item sharing with team key rotation` ·
`fix(rls): add WITH CHECK to time_entries policy` · `chore(deps): bump prisma to 6.2`.

---

## Команды

Запускаются из корня; корневые скрипты — обёртки над `turbo`. Ниже — не полный список, а те, что
нужны чаще всего; **источник истины — `scripts` в корневом `package.json`**
(`node -e "console.log(Object.keys(require('./package.json').scripts).join('\n'))"`), развёрнуто —
[`docs/architecture/stack.md`](docs/architecture/stack.md), раздел «Команды». Набор не заморожен на
EPIC-001 и растёт вместе с эпиками: `dev:landing` пришёл с лендингом, `coverage:baseline` — с CI,
`test:integration:local` — с Testcontainers. Прежде чем сослаться на команду в правиле, документе
или истории — проверь, что она есть в `package.json`.

| Команда | Что делает |
|---|---|
| `pnpm dev` | Параллельно: сервер (tsx watch) + клиент (vite); лендинг сюда не входит |
| `pnpm dev:landing` | Маркетинговый лендинг (`packages/landing`) на 4321 |
| `pnpm build` | `shared` → `server` + `client`, с кешем turbo |
| `pnpm typecheck` | `tsc --noEmit` во всех пакетах |
| `pnpm lint` | ESLint 9 flat config + проверка запретов (`prisma.*` вне persistence, raw `fetch` на клиенте) |
| `pnpm test` | Vitest без Docker во всех пакетах: unit, application, HTTP через supertest, контрактный и permission-набор, repo-тесты |
| `pnpm test:integration` | Vitest + Testcontainers: то, чему нужен реальный сервис — Postgres (RLS, миграции, репозитории), Redis, Mailpit |
| `pnpm test:e2e` | Playwright из `packages/e2e` поверх поднятого стека |
| `pnpm db:migrate` | `prisma migrate dev` (dev) / `deploy` (prod-образ) |
| `pnpm db:seed` | Демо-данные, идемпотентно |
| `pnpm api:gen` | `openapi-typescript docs/api/openapi.yaml` → типы клиента (в CI проверяется пустой diff) |
| `pnpm docker:up` | Postgres, Redis, MinIO, Meilisearch, Mailpit |
| `pnpm turbo run typecheck lint build test` | **CI-before-push** |

---

## Раскладка пакетов и нейминг

### Монорепо

```
bad-crm/
├─ docs/        # спецификация (источник истины)
├─ epics/       # декомпозиция работ
├─ rules/       # правила разработки (.mdc)
└─ packages/
   ├─ shared/   # изоморфный код: zod-примитивы, коды ошибок, каталог permissions, branded id
   ├─ server/   # Express 5 + Prisma + BullMQ
   ├─ client/   # React 19 + Vite
   └─ e2e/      # Playwright поверх поднятого стека
```

Направление зависимостей строго однонаправленное (`import/no-restricted-paths` в CI):
`client → shared`, `server → shared`, `shared → ничего`, `e2e → ничего из исходников`.
Сгенерированные из OpenAPI типы живут в `client`, а не в `shared`.

### Сервер — гексагональные слои

```
packages/server/src/
  domain/          # entities, value-objects, ошибки, access/*.policy.ts — БЕЗ I/O, БЕЗ Prisma, БЕЗ Date.now()
  application/     # ports/ (интерфейсы) + use-cases/ (*.use-case.ts команды, *.query.ts чтения)
  infrastructure/  # persistence/prisma, storage, queue, redis, crypto, ai, search, realtime, mail
  presentation/    # http/: controllers (тонкие), middleware, validators, serializers, error-handler
  main.ts          # composition root, без DI-контейнера
```

- Решение о доступе принимает **policy в `domain`**, вызванная из use-case, — не репозиторий и не
  контроллер.
- Прямой `prisma.*` разрешён **только** внутри `infrastructure/persistence/` (ESLint + CI).
- Одна команда = одна транзакция через `UnitOfWorkPort`; внешние вызовы (S3, SMTP, AI, GitHub)
  никогда не внутри транзакции — только через outbox.
- Суффиксы: `.entity.ts` `.value.ts` `.errors.ts` `.policy.ts` `.port.ts` `.use-case.ts` `.query.ts`
  `.repository.ts` `.adapter.ts` `.controller.ts` `.middleware.ts` `.serializer.ts` `.validator.ts`.

### Клиент — FSD «units»

```
packages/client/src/
  app/       # router.tsx, providers.tsx, routes/**, global.css
  pages/     # page.tsx + ui/ + hooks/ — только композиция
  widgets/   # *.widget.tsx — составные блоки
  units/     # доменные слайсы: api/ service/{queries,mutations,hooks,stores} model/ types/ ui/
  shared/    # api/ ui/ lib/ hooks/
```

- Зависимости только вниз: `app → pages → widgets → units → shared`.
- Call-chain: `ui → service/hooks → service/{queries,mutations} → api → SharedApi`.
- Публичное API слоя/юнита — только через `index.ts` (namespace-barrel: `export * as SteamService …`),
  импорт вглубь мимо barrel запрещён. Все импорты через `@`-алиасы, никаких `../../../`.
- Компонент = вёрстка + хендлеры + вызовы хуков. Ни бизнес-логики, ни фетчинга, ни хелперов рядом.
- `useEffect` — крайняя мера: данные → TanStack Query, производное состояние → вычисление при
  рендере, сброс → `key`, реакция на событие → обработчик.

### Нейминг (client и server одинаково)

- **Имена файлов — всегда kebab-case + role-suffix**: `user-card.component.tsx`, `use-vpn-devices.hook.ts`,
  `task-access.policy.ts`. Никаких `PascalCase.tsx`.
- **Экспорты — named**, без `default`. Компоненты/классы/типы — `PascalCase`, хуки/функции — `camelCase`.
- **Одна ответственность на файл**, один компонент на файл, хелперы — в `*.util.ts`.
- Имена сущностей берутся из [`docs/product/glossary.md`](docs/product/glossary.md) и обязаны
  совпадать: Prisma-модель (`PascalCase`, ед. ч.) = корень unit'а (`kebab-case`, **ед. ч.**) = имя в API.
  Канон — единственное число: `units/task`, `units/dashboard`, `units/file`, а не `units/tasks`,
  `units/dashboards`, `units/files`. Синонимы запрещены: `units/iam` (не `permissions`),
  `units/kb` (не `knowledge-base`), `units/time` (не `time-tracking`).

Норматив — [`rules/naming-and-structure.mdc`](rules/naming-and-structure.mdc).

---

## Проектные агенты (`.claude/agents/`)

Специализированные ревьюеры — по одному файлу на агента в `.claude/agents/`, таблица ниже перечисляет
все. Все только читают и отчитываются — **код не редактируют**. Запускать до коммита, в дополнение
к общему гейту.

| Агент | Когда звать |
|---|---|
| `tenancy-rls-auditor` | Дельта трогает `prisma/schema.prisma`, `prisma/migrations/**`, `infrastructure/persistence/**` или `docs/security/rls-design.md`. Проверяет `organizationId`, `ENABLE`+`FORCE`, `USING`+`WITH CHECK`, GRANT-ы, составные FK, `withTenant`, isolation-тесты с положительным контролем |
| `permission-matrix-auditor` | Дельта трогает каталог permissions, `SYSTEM_ROLE_PERMISSIONS`, `ROUTE_REGISTRY`, `*.policy.ts`, use-cases или снапшот матрицы прав. Ловит вторую точку вычисления прав, 403 вместо 404, фильтрацию списков вне SQL |
| `e2ee-crypto-reviewer` | **Каждое** касание `units/vault/**`, `**/crypto/**`, vault-моделей и миграций, secure links, `docs/security/e2ee-design.md`. Режим «сомнение = FAIL»: утечка открытого текста, повтор nonce, ключи в persistent storage/логах, отсутствие AAD, downgrade алгоритма, отзыв без ротации |
| `openapi-contract-guardian` | Дельта трогает `docs/api/openapi.yaml`, роуты/контроллеры, коды ошибок или сгенерированную схему клиента. Сверяет роуты ↔ спеку в обе стороны, регенерацию типов, отсутствие raw `fetch`, `problem+json` со стабильным кодом, breaking changes |
| `fsd-architecture-linter` | Дельта трогает `packages/client/src/**`. Направление слоёв, импорты мимо barrel, kebab-case + role-suffix, named exports, один компонент на файл, фетчинг в pages/widgets, лишний `useEffect` |
| `realtime-event-reviewer` | Дельта трогает realtime, сокеты, presence, подписки, payload событий. Имена комнат строит сервер, нет broadcast всем, авторизация handshake тем же кодом, что HTTP, проверка прав перед каждым emit, presence только в Redis с TTL, публикация через outbox |
| `search-permission-auditor` | Дельта трогает поиск, индексацию, конфиг Meilisearch или форму индексируемого документа. Права внутри документа (`visibleTo`, `organizationId`), tenant-токен с обязательным фильтром, vault/секреты/ПДн не попадают в индекс, переиндексация при смене ACL |
| `i18n-coverage-checker` | Дельта трогает клиентский UI, файлы локалей или серверные сообщения об ошибках. Хардкод-строки, ключи, отсутствующие в одном из языков, осиротевшие ключи, плюрализация, `Intl` для дат/чисел/валют, серверные ошибки как коды, а не текст |
| `selfhost-upgrade-checker` | Дельта трогает миграции, env, docker-compose, профили или метаданные релиза. expand→migrate→contract, запрет `DROP COLUMN`/`SET NOT NULL` без двух релизов, `CREATE INDEX CONCURRENTLY`, новые обязательные env в `.env.example` **и** в `docs/runbooks/upgrade.md`, работоспособность профиля `minimal`, совместимость бэкапа при `FORCE RLS`, обновление CHANGELOG |
| `stale-claims-auditor` | **Две и более волны агентов работали над одной дельтой**, либо волна фиксов прошла после ревью, либо дельта закрывает историю. Проверяет не код, а утверждения о нём: обоснования принятых рисков, описания отказов в спеке, комментарии «почему», докстринги тестов и двойников, разделы «Сделано»/«Что отложено», жёсткие числа в правилах. Отдельно ревизует пометки «отложено»/`blocked: true`, причина которых устранена соседним эпиком |

Правила запуска (параллелизм, обязательная сверка судьёй при двух и более агентах) —
[`rules/agent-orchestration.mdc`](rules/agent-orchestration.mdc).

---

## Чувствительность данных

### Что нельзя логировать никогда

Пароли и их хеши, мастер-пароль vault, любой ключевой материал (приватные ключи, производные ключи,
KEK/DEK), refresh-токены и их хеши, access JWT, TOTP-секреты и recovery-коды, API-ключи интеграций
(AI, SMTP, GitHub), webhook-секреты, `APP_ENCRYPTION_KEY`, `JWT_SECRET`, `MEILI_MASTER_KEY`,
S3-креды, presigned URL целиком, содержимое vault в любом виде, тела писем.

pino настроен с `redact` по путям (`req.headers.authorization`, `req.headers.cookie`,
`res.headers["set-cookie"]`, `*.password`, `*.token`, `*.refreshToken`, `*.apiKey`, `*.apiKeyEnc`,
`*.secret`, `*.otp`, `*.recoveryCode`) плюс сериализатор ошибок вырезает `config.headers`. **Redact —
страховка, а не разрешение**: не класть секрет в лог осознанно.

**Тело запроса и URL не логируются ни на каком уровне** — включая `debug`. URL защищённой ссылки
сам является учётными данными, а тело — пользовательский контент; в лог идут метод и **шаблон**
маршрута, который идентификаторов не несёт (`infrastructure/logging/http-logger.middleware.ts`).

### Что шифруется

| Данные | Чем | Где ключ |
|---|---|---|
| Содержимое vault, ключи шаринга, secure links | XChaCha20-Poly1305-IETF, Argon2id, `crypto_box_seal`, Ed25519 (`libsodium-wrappers-sumo`) | **только в браузере пользователя**; сервер ключей не имеет |
| API-ключи AI-провайдеров, SMTP-пароли, GitHub-токены, webhook-секреты, TOTP-секреты | AES-256-GCM, формат `v1:<iv>:<tag>:<ciphertext>` | `APP_ENCRYPTION_KEY` (32 байта base64) на сервере |
| Пароли пользователей | argon2id (`@node-rs/argon2`), не шифрование — хеш | — |
| Refresh-токены | SHA-256 хеш в БД, сам токен только в httpOnly cookie | — |

Расшифровка серверных секретов — только в момент использования; расшифрованное не кладётся в
переменные модуля и не возвращается ни в одном API-ответе (наружу — только `apiKeyTail`: «sk-…a91f»).

### Что не попадает в поиск

Vault-элементы и их метаданные-значения, поля `*Enc`/`dataEnc`, ключевой материал, пароли,
персональные данные, не нужные для поиска. Права живут **внутри** индексируемого документа
(`organizationId`, `projectId`, `visibleTo`) — фильтрация «постфактум» в коде запрещена, потому что
индекс живёт вне PostgreSQL и вне RLS.

### Что не попадает в AI

Vault и всё производное от него. **Ни vault, ни `ai`, ни MCP в коде ещё не существуют** (M4+), так
что ниже — контракт, который обязан выполнить заводящий их эпик, а не описание текущего состояния:
контекст `ai` **и MCP-адаптер `presentation/mcp/**`** не имеют порта к контексту `vault` (одним
архитектурным тестом на запрет импорта — он обязан покрывать оба канала, иначе инвариант выполнялся
бы только для одного из них), для vault-сущностей не создаются `EmbeddingChunk`, RAG-ретривер и
поисковые MCP-инструменты работают по allow-list `entityType` без `VAULT_ITEM`, компоненты
`units/vault/ui/**` не имеют доступа к хуку отправки сообщения ассистенту. Ручную вставку секрета
пользователем в чат мы не предотвращаем — рядом с полем ввода стоит предупреждение, что диалог
уходит внешнему провайдеру.

Retrieval для ассистента всегда permission-aware: ассистент не может показать то, чего пользователь
не видит сам. Модель угроз prompt injection — [`docs/security/threat-model.md`](docs/security/threat-model.md).

### Персональные данные

Email, имя, аватар, должность, ставка, записи времени, содержимое чата и комментариев — ПДн и
коммерчески чувствительные данные. В логи попадают только `userId` и `organizationId`, не email и не
содержимое. Экспорт и удаление данных пользователя — часть офбординга, см.
[`docs/security/threat-model.md`](docs/security/threat-model.md), раздел «Приватность и ПДн».

---

## Сообщения пользователю

- Кратко, по делу. Без эмодзи, если не попросили.
- Ссылки на файлы — markdown-формат вида `` `[path:line](path:line)` `` (текст ссылки и цель совпадают).
- На вопрос «можно сделать X?» — сперва проверить `docs/` и `rules/`, ответить со ссылкой.
- После любой технической работы — блок «Что и зачем сделано» (простым языком + технически) и запись
  в `docs/brain/`.
