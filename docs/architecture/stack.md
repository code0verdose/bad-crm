---
doc: stack
project: bad-crm
updated: 2026-07-26
---

# Технологический стек и backend-конвенции

Документ фиксирует **чем** мы строим Bad CRM и **по каким правилам** пишем серверный код.
Границы контекстов и диаграммы C4 — в [`overview.md`](./overview.md).
Сущности, таблицы и RLS-политики — в [`data-model.md`](./data-model.md).
Слои и паттерны клиента — в [`ux-architecture.md`](./ux-architecture.md).
Здесь — стек, раскладка, контракт API, конвенции слоёв, тесты и команды.

Продукт: self-hosted multi-tenant CRM/workspace для команд разработки, AGPL-3.0, EN/RU.
Ключевое следствие лицензии и модели поставки: **любой человек должен уметь поднять проект одной
командой `docker compose up`**, поэтому стек намеренно консервативен, а всё «дорогое»
(поиск, AI) — опционально.

---

## Обзор стека

| Слой | Технология | Версия | Зачем | ADR |
|---|---|---|---|---|
| Монорепо | pnpm workspaces + turborepo | pnpm 9+, turbo 2+ | Общие типы и OpenAPI между client/server без publish; кеш задач в CI | [ADR-0001](./adr/0001-monorepo-pnpm-turborepo.md) |
| Язык | TypeScript strict | **5.9.3** (точный пин, одна версия на весь воркспейс) | Один язык на весь стек, доменные инварианты в типах; TS 7 не берём, пока `typescript-eslint` не поддержит его API — иначе type-aware правила молча отключаются | [ADR-0001](./adr/0001-monorepo-pnpm-turborepo.md), [ADR-0022](./adr/0022-typescript-version-policy.md) |
| Runtime | Node.js LTS | 22.x | LTS до 2027, native fetch/test runner/WebCrypto | — |
| HTTP-фреймворк | Express | 5.x | Текущая рекомендованная ветка (5.2+): та же предсказуемость и тот же объём готовых middleware, плюс встроенная обработка async-ошибок (отклонённый промис сам доходит до error-handler); вся структура всё равно в use-cases. ADR-0002 охватывает и выбор ветки Express 5.x | [ADR-0002](./adr/0002-hexagonal-backend-express-prisma.md) |
| Архитектура сервера | Hexagonal (ports & adapters) | — | Домен и правила доступа тестируются без БД; инфраструктура заменяема | [ADR-0002](./adr/0002-hexagonal-backend-express-prisma.md) |
| БД | PostgreSQL + pgvector | 16 / 0.7+ | Одна БД на всё: реляционка, JSONB, полнотекст, векторы, RLS-изоляция тенантов | [ADR-0004](./adr/0004-multi-tenancy-postgres-rls.md) |
| ORM | Prisma | 5.x/6.x | Типобезопасные запросы, миграции, `$extends` для tenant-контекста | [ADR-0002](./adr/0002-hexagonal-backend-express-prisma.md) |
| Валидация | zod | 4.x | Одна схема = рантайм-проверка + тип; общая с клиентом через `packages/shared` | — |
| Контракт API | OpenAPI 3.1 + `openapi-typescript` | 3.1 / 7.x | Спека — source of truth; клиент типизирован генерацией, а не руками | [ADR-0003](./adr/0003-openapi-as-source-of-truth.md) |
| Логи | pino + pino-http | **10.x / 11.x** | Structured JSON, самый низкий overhead в Node. Взята текущая стабильная ветка (STORY-003-03): `pino-http@11` требует `pino@^10`, и брать 9.x означало бы ставить заведомо устаревшую пару в первый же коммит сервера | — |
| Очереди | BullMQ + ioredis | 5.x | Ретраи, DLQ, delayed/repeatable jobs поверх уже нужного Redis | [ADR-0021](./adr/0021-transactional-outbox.md) |
| Кеш/pub-sub | Redis | **8.x** | Сессии-ревокации, rate-limit, backplane для socket.io, брокер BullMQ. Именно 8.x: 7.4 распространяется только под RSALv2/SSPLv1 (запрещены), AGPLv3 появился в Redis 8.0 — см. [`../legal/licensing.md`](../legal/licensing.md) §4 | [ADR-0010](./adr/0010-realtime-socketio-redis-adapter.md), [ADR-0021](./adr/0021-transactional-outbox.md) |
| Хеш паролей | `@node-rs/argon2` | 2.x | argon2id — рекомендация OWASP; Rust-биндинг быстрее `node-argon2` и не требует node-gyp | — |
| Токены | `jsonwebtoken` + `otplib` | 9.x / 12.x | Короткий JWT access + rotating refresh в cookie; TOTP как второй фактор | — |
| HTTP-безопасность | helmet, cors, cookie-parser, `rate-limiter-flexible` | latest | CSP/HSTS, строгий CORS, распределённый лимит на Redis | — |
| Файлы | `@aws-sdk/client-s3` + `s3-request-presigner` | 3.x | S3-совместимость: MinIO локально, любой S3 в проде; presigned upload минует Node | [ADR-0015](./adr/0015-s3-file-storage-presigned-urls.md) |
| Поиск | Meilisearch | 1.x | Мгновенный typo-tolerant поиск, MIT, лёгкий по RAM; **опционален** (профиль `minimal` → `postgres-fts.adapter.ts`) | [ADR-0011](./adr/0011-meilisearch-permission-aware-search.md) |
| Realtime | `socket.io` + `@socket.io/redis-streams-adapter` | 4.x | Комнаты по тенанту/сущности, авто-fallback, горизонтальное масштабирование | [ADR-0010](./adr/0010-realtime-socketio-redis-adapter.md) |
| Почта | nodemailer | 9.x | SMTP без вендор-лока; Mailpit в dev (MailHog заброшен с 2020) | — |
| AI | `@anthropic-ai/sdk`, `openai` (в т.ч. `openai_compat` и `openrouter` через OpenAI-совместимый клиент) | latest | Четыре вида провайдера за одним портом; **опционально**, ключи вводит администратор организации в UI и они хранятся зашифрованными в `AIProvider` | [ADR-0014](./adr/0014-ai-provider-abstraction.md) |
| Тесты | Vitest, supertest, Testcontainers, Playwright, RTL | latest | Один раннер на монорепо; реальный Postgres — единственный способ проверить RLS | — |
| Клиент | React 19, Vite, Mantine 9, TanStack Query v5 / Router, i18next | latest | Детали — в [`ux-architecture.md`](./ux-architecture.md) | [ADR-0005](./adr/0005-fsd-units-frontend-architecture.md), [ADR-0006](./adr/0006-mantine-css-modules-no-tailwind.md), [ADR-0007](./adr/0007-tanstack-router-and-query.md) |
| Лицензии | Только AGPL-совместимые | — | Никаких BSL/SSPL/Commons Clause/«free for non-commercial» | [ADR-0018](./adr/0018-license-agpl-3.md) |

Нумерация ADR — единая на весь проект (23 записи, полный список — в
[`overview.md`](./overview.md#ключевые-архитектурные-решения) и каталоге [`adr/`](./adr/)).
Прочерк означает, что решение зафиксировано этим документом и отдельного ADR не имеет; заводить
новые номера в обход общего списка нельзя.

Отвергнутые альтернативы верхнего уровня (подробности — в соответствующих ADR):
NestJS (лишний DI-фреймворк поверх и без того явного composition root), Fastify (выигрыш в RPS не
критичен для self-host нагрузки, экосистема middleware беднее), Drizzle (миграции и introspection
менее зрелые для 40+ таблиц), MongoDB (нужны транзакции и RLS), Elasticsearch (гигабайты RAM на
self-host инстансе), Kafka (несоразмерно масштабу; BullMQ + outbox закрывают задачу).

---

## Требования к среде

**Разработка**

| Что | Требование | Как фиксируется |
|---|---|---|
| Node.js | 22 LTS для разработки и CI; `engines` — `>=22.22.1` **без верхней границы** | `.nvmrc` (`22.22.1`) — то, на чём работают контрибьютор и CI. Флор задан хуками (`lint-staged@17` требует `node >=22.22.1`, `@commitlint/cli@21` — `>=22.12.0`). Потолка нет намеренно: `<23` был написан руками, не измерен и **выключил обновления зависимостей** — Dependabot запускает npm-апдейтер на Node 24, не смог удовлетворить диапазон и ответил `tool_version_not_supported` по каждому пакету. Набор прогнан на Node 24 целиком и прошёл; падала только сама проверка диапазона. Утверждение проверяется джобой `compat` в `ci.yml` (push в `main` и еженедельно) |
| pnpm | 10+ | `packageManager: "pnpm@10.x.x"` в корневом `package.json` (Corepack) |
| TypeScript | 5.9.3, одна версия на весь воркспейс | точный пин в корне и в каждом пакете; проверяется `test/repo/toolchain-versions.test.ts` ([ADR-0022](./adr/0022-typescript-version-policy.md)) |
| Docker | 24+ с Compose v2 | `pnpm docker:up` поднимает Postgres/Redis/MinIO/Meilisearch/Mailpit; голый `docker compose up -d` — только минимальный набор |
| ОС | Linux / macOS / WSL2 | Windows — только через WSL2 (Testcontainers, права на volume) |

Ресурсы для разработки: 8 GB RAM (4 GB — если поднимать профиль `minimal`), 10 GB диска.

**Self-host (продакшен)**

| Профиль | Сервисы | CPU / RAM (порог старта) | Что это значит |
|---|---|---|---|
| `minimal` | app + Postgres + Redis + MinIO | 2 vCPU / 2 GB | Минимум, при котором стек стартует. Без поиска и AI |
| `default` | + Meilisearch | 2 vCPU / 4 GB | Минимум, при котором стартует полный набор. **Не рабочая нагрузка:** сайзинг под реальную команду — [hosting.md](../runbooks/hosting.md) |
| `scaled` | + отдельные worker-контейнеры, внешний S3/managed Postgres | 4+ vCPU / 8+ GB | 100+ пользователей, несколько организаций |

Приложение обязано стартовать и работать без Meilisearch и без AI-ключей — деградация функций,
а не отказ (см. «Конфигурация и env»).

---

## Раскладка монорепо

```
bad-crm/
├─ package.json              # корень: скрипты-обёртки над turbo, engines, packageManager
├─ pnpm-workspace.yaml       # packages/*
├─ turbo.json                # pipeline задач и кеш
├─ tsconfig.base.json        # strict + noUncheckedIndexedAccess, общие compilerOptions
├─ eslint.config.js          # ESLint 9 flat config на весь репозиторий
├─ .nvmrc  .env.example  docker-compose.yml
├─ docs/                     # PRD, архитектура, ADR, openapi.yaml, runbooks
├─ epics/                    # декомпозиция работ
└─ packages/
   ├─ shared/                # изоморфный код: zod-схемы общих value-objects, коды ошибок,
   │                         # константы ролей/прав, утилиты дат и денег, типы событий
   ├─ server/                # Express + Prisma + BullMQ (см. следующий раздел)
   ├─ client/                # React 19 + Vite (см. ux-architecture.md)
   └─ e2e/                   # Playwright: сценарии поверх поднятого стека
```

**Направление зависимостей — строго однонаправленное, проверяется ESLint-правилом
`import/no-restricted-paths` и `depcheck` в CI:**

```
client ──► shared
server ──► shared
e2e   ──► (ничего из исходников; только HTTP/UI поднятого приложения)
shared ──► (ничего из packages)
```

- `shared` не импортирует ни Node-only API (`fs`, `crypto` из node), ни браузерные (`window`) —
  только то, что работает в обоих рантаймах. Проверяется отдельным tsconfig с `lib: ["ES2023"]`
  без `DOM` и без `@types/node`.
- `e2e` намеренно не зависит от `server`: тест не должен «знать» внутренности, иначе он перестаёт
  быть end-to-end. Тестовые данные готовит через публичный API и seed-скрипт.
- Сгенерированные из OpenAPI типы живут в `client`, а не в `shared`: это артефакт сборки клиента,
  и `server` не должен от них зависеть (иначе спека перестаёт быть независимым контрактом).

**Turborepo pipeline** (`turbo.json`, сокращённо):

```jsonc
{
  "tasks": {
    "build":     { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "typecheck": { "dependsOn": ["^build"], "outputs": [] },
    "lint":      { "outputs": [] },
    "test":      { "dependsOn": ["^build"], "outputs": ["coverage/**"] },
    "test:e2e":  { "dependsOn": ["^build"], "cache": false },
    "db:migrate":{ "cache": false },
    "dev":       { "cache": false, "persistent": true }
  }
}
```

- `^build` означает «сначала собери зависимости пакета»: `server` и `client` не соберутся, пока не
  собран `shared`.
- `test:e2e` и всё, что трогает БД, — `cache: false`: результат зависит от внешнего состояния.
- Кеш локальный по умолчанию; remote cache в open-source CI не включаем (не хотим завязки на
  вендорский сервис в публичном репозитории).

---

## Backend: гексагональная архитектура

```
packages/server/src/
  domain/
    <context>/                # tasks, projects, docs, kb, chat, billing, identity, ...
      *.entity.ts             # сущность с инвариантами: task.entity.ts
      *.value.ts              # value-object: money.value.ts, slug.value.ts
      *.errors.ts             # доменные ошибки: task.errors.ts
      access/*.policy.ts      # правила доступа: task-access.policy.ts
    shared/
      errors/                 # базовые классы: DomainError, NotFoundError, ForbiddenError
      ids/                    # branded id-типы: OrganizationId, UserId, TaskId
      money/  result/         # общие value-objects и Result<T, E>
  application/
    <context>/
      ports/                  # интерфейсы, которые нужны use-case'ам
        task-repository.port.ts
        task-access-reader.port.ts
        clock.port.ts  outbox.port.ts  file-storage.port.ts
      use-cases/
        create-task.use-case.ts       # КОМАНДА: меняет состояние
        move-task-column.use-case.ts
        list-tasks.query.ts           # ЧТЕНИЕ: не меняет состояние
        get-task-detail.query.ts
  infrastructure/
    persistence/prisma/       # PrismaXRepository, маппинг entity ↔ row, tenant-клиент
    storage/  queue/  redis/  crypto/  ai/  search/  realtime/  logging/  mail/
    integrations/             # github (входящие webhooks + чтение API), smtp-провайдеры
    bootstrap/                # сборка контейнеров зависимостей по контекстам
  presentation/http/
    server.ts  routes.ts
    controllers/              # task.controller.ts — тонкий: parse → use-case → serialize
    middleware/               # auth, tenant-context, request-id, rate-limit, error-handler
    validators/               # zod-схемы запросов: create-task.validator.ts
    serializers/              # entity → DTO из OpenAPI: task.serializer.ts
    error-handler.ts
  main.ts                     # composition root: env → адаптеры → use-cases → HTTP/worker
```

### domain — правила предметной области

**Можно:** классы сущностей с инвариантами, value-objects, доменные ошибки, чистые функции,
policy-объекты, импорт из `domain/shared` и `packages/shared`.
**Нельзя:** импортировать Prisma, Express, Redis, `process.env`, `Date.now()`, любые I/O.
Время приходит через `ClockPort`, идентификаторы — через `IdGeneratorPort`.

Ключевое правило проекта: **решение о доступе принимает policy в domain, а не репозиторий.**

```ts
// domain/tasks/access/task-access.policy.ts
export interface TaskAccessSubject {
  userId: UserId;
  organizationId: OrganizationId;
  role: OrganizationRole;
  projectMemberships: ReadonlyMap<ProjectId, ProjectRole>;
}

export function canMoveTaskToColumn(subject: TaskAccessSubject, task: Task): AccessDecision {
  if (task.organizationId !== subject.organizationId) return denied('task_not_found');
  if (subject.role === 'owner' || subject.role === 'admin') return allowed();
  const projectRole = subject.projectMemberships.get(task.projectId);
  if (!projectRole) return denied('task_forbidden');
  return projectRole === 'viewer' ? denied('task_forbidden') : allowed();
}
```

Такая policy — чистая функция от subject и объекта, поэтому покрывается юнит-тестами на 100%
без БД. Отвергнутая альтернатива — «фильтровать по правам прямо в SQL-запросе репозитория»: тогда
правило доступа размазывается по десяткам запросов и его невозможно протестировать отдельно.
RLS в Postgres — второй, независимый рубеж (защита от ошибки в коде), а не замена policy.

### application — сценарии

**Можно:** зависеть от `domain` и от собственных `ports`. **Нельзя:** знать про Prisma, Express,
HTTP-статусы, socket.io. Use-case не знает, что его вызвали по HTTP.

**Порты — два разных вида, и их нельзя путать:**

```ts
// application/tasks/ports/task-repository.port.ts
// Пишущая сторона: загружает и сохраняет АГРЕГАТ целиком. Ничего не знает о правах.
export interface TaskRepositoryPort {
  findById(id: TaskId): Promise<Task | null>;
  save(task: Task): Promise<void>;
  delete(id: TaskId): Promise<void>;
}

// application/tasks/ports/task-access-reader.port.ts
// Читающая сторона для проверки прав: собирает subject-контекст для policy.
export interface TaskAccessReaderPort {
  loadSubject(userId: UserId, organizationId: OrganizationId): Promise<TaskAccessSubject>;
}
```

Суффикс `*-repository.port.ts` — всегда агрегат целиком (для команд).
Суффикс `*-access-reader.port.ts` — только данные для принятия решения о доступе.
Третий вид — `*-query.port.ts` для read-моделей списков (плоские DTO, JOIN-ы, пагинация);
он возвращает не сущности, а готовые проекции.

**Команды и чтения разделены по имени файла:**

| Файл | Что делает | Транзакция | Возвращает |
|---|---|---|---|
| `*.use-case.ts` | меняет состояние | да, одна на сценарий | id / DTO результата |
| `*.query.ts` | только читает | нет (или read-only) | плоскую read-модель |

Это не полноценный CQRS с раздельными хранилищами — одна БД, но разные пути чтения и записи.
Причина: списки задач/задач требуют JOIN-ов и агрегатов, которые бессмысленно гонять через
загрузку агрегатов. Отвергнутая альтернатива — единый «сервис на контекст»: он неизбежно
разрастается и смешивает транзакционную запись с отчётными выборками.

```ts
// application/tasks/use-cases/move-task-column.use-case.ts
export class MoveTaskColumnUseCase {
  constructor(
    private readonly tasks: TaskRepositoryPort,
    private readonly access: TaskAccessReaderPort,
    private readonly outbox: OutboxPort,
    private readonly clock: ClockPort,
    private readonly uow: UnitOfWorkPort,
  ) {}

  async execute(input: MoveTaskColumnInput): Promise<void> {
    return this.uow.withTransaction(async () => {
      const task = await this.tasks.findById(input.taskId);
      if (!task) throw new NotFoundError('task_not_found');

      const subject = await this.access.loadSubject(input.userId, input.organizationId);
      assertAllowed(canMoveTaskToColumn(subject, task));       // ← решение в domain

      task.moveToColumn(input.columnId, input.position, this.clock.now()); // ← инвариант в entity
      await this.tasks.save(task);
      await this.outbox.publish(taskColumnMoved(task));       // ← событие в той же транзакции
    });
  }
}
```

### infrastructure — реализации портов

**Можно:** Prisma, Redis, S3, socket.io, HTTP-клиенты сторонних сервисов.
**Нельзя:** содержать бизнес-правила и решения о доступе; экспортировать Prisma-типы наружу
(наружу отдаются доменные сущности или read-модели).

Прямой вызов `prisma.*` разрешён **только** внутри `infrastructure/persistence/`. Правило
включено в ESLint (`no-restricted-imports` на `@prisma/client` + `no-restricted-syntax` на
`prisma.` вне разрешённого пути) и падает в CI. Причина — без него `prisma.task.findMany()`
за месяц просачивается в контроллеры и убивает всю раскладку.

### presentation/http — тонкий транспорт

Контроллер делает ровно четыре вещи: валидирует вход zod-схемой из `validators/`, достаёт
контекст (`requestId`, `userId`, `organizationId`) из middleware, вызывает один use-case,
сериализует ответ в DTO из OpenAPI. Никаких `if (user.role === ...)` в контроллере — это policy.
Ошибки не ловятся здесь: доменные ошибки летят до `error-handler.ts`, который маппит их в
`application/problem+json`.

**Express 5 и async-ошибки.** В Express 5 async-хендлеры автоматически пробрасывают отклонённые
промисы в error-handler, поэтому обёртка `asyncHandler` и пакет `express-async-errors` **не нужны** —
контроллер пишется как обычная `async`-функция без `try/catch`. За двумя отличиями от 4.x надо
следить отдельно. Первое: `req.query` теперь **getter** — объект пересобирается на каждое обращение,
мутировать его нельзя, поэтому нормализованные и перезаписанные параметры складываем в собственный
объект или в `res.locals`, а не обратно в `req.query`. Второе: изменился синтаксис path-параметров —
безымянный `*` больше не поддерживается, вместо него нужен именованный wildcard вида `/files/*splat`;
также изменилась семантика опционального `?` и regex в путях, поэтому все нестандартные маршруты
проверяются контрактным тестом «route ↔ спецификация».

### main.ts — composition root и graceful shutdown

Единственное место, где создаются конкретные адаптеры и связываются с use-cases. DI-контейнер
не используем: явная сборка функциями читается лучше и не требует декораторов и метаданных.

```ts
// main.ts (сокращённо)
async function bootstrap() {
  const env = loadEnv();                                  // zod-схема, падает при старте
  const logger = createLogger(env);
  const prisma = createPrismaClient(env);
  const redis = createRedis(env);
  const container = buildContainer({ env, prisma, redis, logger });

  const app = createHttpServer(container);
  const server = app.listen(env.PORT);
  const workers = env.RUN_WORKERS_IN_PROCESS ? startWorkers(container) : [];

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutdown started');
    server.close();                                       // 1. перестать принимать новые запросы
    await setReady(false);                                // 2. /ready → 503, балансировщик уводит
    await Promise.all(workers.map((w) => w.close()));     // 3. дать job'ам доработать
    await container.realtime.close();                     // 4. закрыть сокеты
    await prisma.$disconnect();
    await redis.quit();
    process.exit(0);
  };
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => void shutdown(sig));
}
```

Жёсткий таймаут на shutdown — 30 c, после чего `process.exit(1)`: зависший worker не должен
держать деплой. **Воркер — отдельный процесс с первого дня** (`ROLE=worker`, тот же образ и тот же
`buildContainer`, см. [`overview.md`](./overview.md#c4-уровень-2--контейнеры)): он потребляет outbox
и внешние API (LLM-стриминг, GitHub), где одна медленная операция иначе занимала бы event loop
HTTP-обработчика. `RUN_WORKERS_IN_PROCESS=true` — осознанное исключение для профиля `minimal`
(одна машина, минимум памяти), а не значение по умолчанию.

**Сигнал обязан дойти до процесса Node — иначе весь graceful shutdown не выполняется, и это не
видно ни в одном тесте.** Проверено при реализации (STORY-003-01), требования к образу:

- **`CMD` только в exec-форме** (`CMD ["node", "dist/main.js"]`). В shell-форме PID 1 становится
  `/bin/sh`, который ничего не пересылает: контейнер каждый раз досиживает полный stop-timeout и
  умирает по `SIGKILL`, обрывая все запросы в полёте. Симптом на стороне пользователей — обрывы
  ровно во время деплоя, при формально «корректном» коде остановки.
- **Node как PID 1 сигнал получает** — но только потому, что обработчик зарегистрирован: для PID 1
  ядро отбрасывает сигналы, у которых нет обработчика (действия по умолчанию не применяются).
  Следствие: обработчики регистрируются в `startApiProcess` сразу после `listen`, до первого
  запроса.
- **`init: true` в compose (или `docker run --init`)** — не ради сигналов, а ради reaping зомби:
  PID 1 без этого не собирает потомков (`prisma migrate`, вызовы дочерних процессов).
- Таймаут остановки контейнера должен быть **больше** 30-секундного жёсткого таймаута shutdown,
  иначе `SIGKILL` приходит раньше, чем процесс успевает закрыть Prisma и Redis.

### Алиасы и модульная система

`"module": "NodeNext"`, `"moduleResolution": "NodeNext"`, алиас `@/*` → `src/*`, на билде пути
разворачиваются `tsc-alias`. Причина такого сочетания: NodeNext даёт корректную семантику ESM/CJS
и точные ошибки на импортах, но не умеет резолвить `paths` в рантайме — `tsc-alias` переписывает
их в относительные пути после `tsc`. В dev используется `tsx` (понимает `paths` из tsconfig).
Отвергнутые альтернативы: `module-alias` в рантайме (правит require на лету, ломает ESM),
bundler на сервере (лишний шаг сборки ради того же результата).

---

## Контракт API

### Contract-first флоу

```
docs/api/openapi.yaml   ←── source of truth, правится руками в PR
        │
        ├── pnpm api:gen ──► openapi-typescript
        │                    → packages/client/src/shared/api/schemas/api-schema.d.ts
        │                    (файл в git, генерация проверяется в CI: diff должен быть пустым)
        │
        ├── контрактный тест (packages/server) ──► сверяет реальный роутер со спекой
        └── клиент: openapi-fetch + openapi-react-query поверх сгенерированных типов
```

**Контрактный тест обязателен и двусторонний.** Он берёт список зарегистрированных Express-роутов
(`app._router.stack`, нормализуя `:param` → `{param}`) и множество `paths × methods` из
`openapi.yaml`, после чего проверяет два условия:

1. нет ни одного route, которого нет в спеке (кроме явного allow-list: `/health`, `/ready`,
   `/metrics`, `/socket.io`);
2. нет ни одной операции в спеке, для которой нет route.

Тест падает раньше, чем расхождение доедет до клиента. Отвергнутая альтернатива — генерировать
спеку из кода (`zod-to-openapi` и подобное): спека перестаёт быть договором и начинает описывать
случайное текущее поведение, ревьюить изменения API становится нечем.

### Версионирование

Все продуктовые endpoint'ы живут под `/api/v1`. Внутри `v1` разрешены только совместимые
изменения: добавление опциональных полей и новых endpoint'ов. Ломающие изменения — только новый
префикс `/api/v2` с параллельной поддержкой `v1` не менее одного минорного релиза, о снятии
объявляем в CHANGELOG. Отдельно от версии API живёт `X-App-Version` в ответах — клиент по
несовпадению предлагает перезагрузить SPA.

### Формат ошибок — `application/problem+json` (RFC 9457)

Один формат на все ошибки, включая валидацию. `code` — стабильный машинный идентификатор, по
которому клиент выбирает i18n-сообщение; `title`/`detail` — для логов и разработчика, они **не**
показываются пользователю напрямую и могут меняться без мажорной версии.

```json
{
  "type": "https://bad-crm.dev/problems/validation-failed",
  "title": "Request validation failed",
  "status": 422,
  "code": "validation_failed",
  "detail": "2 fields are invalid",
  "instance": "/api/v1/tasks",
  "requestId": "01J8Z2F5Q3K9V6N0R4T7YB3XQD",
  "errors": [
    { "path": "title",        "code": "too_small",    "message": "String must contain at least 1 character" },
    { "path": "amount.value", "code": "invalid_type", "message": "Expected number, received string" }
  ]
}
```

Каталог кодов ведётся в `packages/shared/src/errors/error-code.enums.ts` и обязан совпадать с `enum` в
спеке — это проверяет тот же контрактный тест. Правила соответствия:

| Ситуация | HTTP | `code` |
|---|---|---|
| zod-валидация тела/query | 422 | `validation_failed` |
| не аутентифицирован / access истёк | 401 | `unauthenticated` |
| нет прав (policy `denied`) | 403 | `<resource>_forbidden` |
| объект не найден **или** не виден тенанту | 404 | `<resource>_not_found` |
| маршрута не существует | 404 | `route_not_found` |
| тело запроса больше 1 MB | 413 | `payload_too_large` |
| конфликт версий (optimistic lock) | 409 | `stale_version` |
| дубликат по уникальному ключу | 409 | `<resource>_already_exists` |
| превышен rate limit | 429 | `rate_limited` (+ `Retry-After`) |
| внутренняя ошибка | 500 | `internal_error` (без `detail` наружу) |

Две последние строки — транспортные отказы, решение по которым принимается **до** того, как известен
ресурс, поэтому они не могут заимствовать `<resource>_…`-код: `route_not_found` вместо
`task_not_found` на опечатку в URL, `payload_too_large` вместо валидации на теле, которое парсер
отверг целиком (добавлены в каталог в STORY-003-01).

Важное правило приватности: «нет доступа к чужой организации» отдаётся как **404**, а не 403 —
иначе API становится оракулом существования сущностей в других тенантах. 403 отдаём только
внутри своей организации.

### Пагинация

| Тип данных | Схема | Почему |
|---|---|---|
| Ленты: activity, comments, chat-сообщения, уведомления, audit log | **cursor** (`?cursor=&limit=`), ответ `{ items, nextCursor }` | Данные постоянно дописываются сверху; offset даёт дубли и пропуски, а `OFFSET 10000` — seq scan |
| Таблицы: задачи, проекты, сотрудники, документы, файлы, инвойсы | **offset** (`?page=&perPage=&sort=`), ответ `{ items, total, page, perPage }` | Нужны «стр. 7 из 42», произвольная сортировка и точный счётчик |
| Канбан-колонки | cursor + `fractional-indexing` для порядка | Порядок задаётся пользователем, не сортировкой БД |

Курсор — opaque base64url от `{ sortKey, id }`, всегда с tie-breaker по `id`, иначе записи с
одинаковым timestamp теряются. `limit` ограничен сверху (по умолчанию 50, максимум 100).
`total` для offset-списков считается отдельным `COUNT(*)` и кешируется на 10 c при больших
выборках.

### Идемпотентность

Все небезопасные методы (`POST`, `PATCH`, `DELETE`), которые создают сущности, отправляют почту
или тратят деньги/токены, принимают заголовок `Idempotency-Key` (UUIDv4, генерирует клиент).
Сервер хранит в таблице `idempotency_key` кортеж `(organization_id, key, endpoint, request_hash,
response_status, response_body, created_at)` с TTL 24 ч:

- ключ не встречался → выполняем, сохраняем ответ в той же транзакции;
- ключ встречался, `request_hash` совпал → отдаём сохранённый ответ, не выполняя ничего;
- ключ встречался, `request_hash` другой → 409 `idempotency_key_reuse`.

Клиент обязан слать `Idempotency-Key` на все мутации (это делает обёртка над `openapi-fetch`).
Причина — ретраи при обрывах сети иначе создают дубли задач и повторные списания AI-токенов.

### Правило клиента

**Никакого raw `fetch` в клиентском коде.** Все вызовы идут через `openapi-fetch`-клиент,
типизированный сгенерированной `api-schema.d.ts`; ESLint запрещает `fetch(` и `axios` вне
`packages/client/src/shared/api`. Следствие: несуществующий путь, лишний query-параметр или
неверная форма тела — ошибка компиляции, а не 400 в проде.

---

## Работа с БД

### Tenant-контекст и RLS

Изоляция организаций держится на **двух независимых рубежах**: policy в domain (см. выше) и
Row Level Security в Postgres. RLS читает `current_setting('app.organization_id')`, поэтому
переменную нужно выставлять в той же сессии/транзакции, где выполняется запрос.

Prisma выдаёт соединение из пула, и `SET` вне транзакции утечёт на чужой запрос. Поэтому
единственный разрешённый способ — **интерактивная транзакция**, которая пинит соединение:

```ts
// infrastructure/persistence/prisma/tenant-client.ts
import { AsyncLocalStorage } from 'node:async_hooks';

export interface TenantContext {
  organizationId: string;
  userId: string | null;
  bypassRls?: boolean;           // только для миграций/системных job'ов, логируется
}

const als = new AsyncLocalStorage<{ ctx: TenantContext; tx: Prisma.TransactionClient }>();

/** Открывает транзакцию, фиксирует в ней tenant-контекст и кладёт её в ALS. */
export async function withTenant<T>(
  base: PrismaClient,
  ctx: TenantContext,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return base.$transaction(async (tx) => {
    // set_config(..., is_local = true) — параметризуемый аналог SET LOCAL:
    // действует до конца транзакции и не переживает возврат соединения в пул.
    await tx.$executeRaw`SELECT set_config('app.organization_id', ${ctx.organizationId}, true)`;
    await tx.$executeRaw`SELECT set_config('app.user_id', ${ctx.userId ?? ''}, true)`;
    return als.run({ ctx, tx }, () => fn(tx));
  });
}

/** Расширение-предохранитель: запрос вне withTenant не уходит в БД вообще. */
export function guardedClient(base: PrismaClient): PrismaClient {
  return base.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const store = als.getStore();
          if (!store) {
            throw new Error(`Tenant context is missing for ${model}.${operation}`);
          }
          return query(args);
        },
      },
    },
  }) as unknown as PrismaClient;
}
```

Приложение подключается к БД под ролью **без** `BYPASSRLS` — иначе политики молча не применяются.
Миграции и seed идут под отдельной ролью-владельцем. Системные job'ы, которым нужен обход
(например, глобальные rollup'ы), используют явный `bypassRls: true` и пишут запись в audit log.

Отвергнутая альтернатива — фильтровать `organizationId` вручную в каждом запросе: один забытый
`where` = утечка между тенантами, и никакой тест этого системно не поймает. RLS ловит забытый
фильтр на уровне БД.

### Транзакционные границы

- Одна команда (`*.use-case.ts`) = одна транзакция, открытая через `UnitOfWorkPort` (реализация —
  `withTenant`). Вложенных транзакций нет; вложенный вызов переиспользует ту, что в ALS.
- `*.query.ts` транзакцию не открывают — читают через тот же tenant-скоуп в read-only режиме.
- Внешние вызовы (S3, SMTP, AI, GitHub) **никогда** не делаются внутри транзакции: медленный
  HTTP держит соединение и блокировки. Всё внешнее уходит в outbox и исполняется job'ом.
- Оптимистичная блокировка через колонку `version` на изменяемых конкурентно агрегатах (задача,
  документ, инвойс): `UPDATE ... WHERE id = $1 AND version = $2`, 0 строк → 409 `stale_version`.
- Таймаут транзакции — 5 c (`maxWait: 2s, timeout: 5s`), долгие операции разбиваются на job'ы.

### Миграции: expand → migrate → contract

Prisma Migrate, файлы в `packages/server/prisma/migrations`, применяются `prisma migrate deploy`
на старте контейнера (или отдельным job'ом в `scaled`). Любое изменение, ломающее старую версию
кода, разбивается на три релиза:

1. **expand** — добавить новое (nullable-колонка, новая таблица, новый индекс `CONCURRENTLY`),
   старый код продолжает работать;
2. **migrate** — задеплоить код, который пишет и читает по-новому; фоновым job'ом заполнить
   данные батчами;
3. **contract** — в следующем релизе удалить старое (колонку, таблицу), когда никто не читает.

Жёсткие запреты в миграциях: `DROP COLUMN`/`DROP TABLE` в том же релизе, что и смена кода;
переименование колонки (только add + backfill + drop); `CREATE INDEX` без `CONCURRENTLY` на
таблицах с данными; блокирующий `ALTER TABLE ... SET NOT NULL` без предварительного
`CHECK ... NOT VALID` + `VALIDATE CONSTRAINT`. Каждая миграция ревьюится агентом `db-reviewer`.
Новая таблица без RLS-политики — блокирующее замечание ревью (список политик — в
[`data-model.md`](./data-model.md)).

### Seed

`pnpm db:seed` создаёт демо-организацию, роли, пользователей (`owner@demo.local` и др.), проект,
доску, десяток задач, записи времени, пару документов и статей KB. Скрипт идемпотентен (`upsert` по
стабильным id), поэтому его можно гонять повторно. Он же используется как фикстура для e2e.

---

## Фоновые задачи и outbox

### Transactional outbox

Проблема: нельзя атомарно и записать в БД, и отправить письмо/проиндексировать/разослать событие.
Решение: use-case пишет событие в таблицу `outbox_event` **в той же транзакции**, что и изменение
данных. Отдельный диспетчер читает неотправленные события и раскладывает их по очередям BullMQ.

```
[ transaction ]  task UPDATE  +  outbox_event INSERT
                        │
              dispatcher (poll 1s + LISTEN/NOTIFY)
                        │
        ┌───────────┬───────────┬─────────────┬──────────┐
   search-index  embeddings   rollups        mail    github-sync
```

Диспетчер помечает событие `processing` через `SELECT ... FOR UPDATE SKIP LOCKED` — это позволяет
запускать несколько реплик диспетчера без дублей. Отвергнутая альтернатива — публиковать в очередь
прямо из use-case: при откате транзакции job уже в Redis и обрабатывает несуществующие данные.

### Очереди

| Очередь | Что делает | Ретраи | Особенности |
|---|---|---|---|
| `outbox` | развозит доменные события по остальным очередям | 10, exp backoff 1s→5min | самая критичная; лаг мониторим |
| `search-index` | синхронизирует документы в Meilisearch | 5 | no-op, если поиск выключен |
| `embeddings` | считает векторы для KB/поиска через AI-порт | 3 | no-op без AI-ключей; батчинг по 32 |
| `rollups` | пересчёт метрик дашбордов, отчётов, счётчиков | 3 | repeatable job раз в 5 мин + по событию |
| `mail` | письма через nodemailer | 5, backoff до 30 мин | rate-limit на очереди (SMTP-квоты) |
| `github-sync` | чтение статусов Actions, деплоев и коммитов (**односторонне**: из GitHub в Bad CRM; двусторонняя синхронизация issue/PR — backlog, см. roadmap) | 5 | учитывает GitHub rate limit, `Retry-After` |

**Ретраи:** экспоненциальный backoff с jitter (`{ type: 'exponential', delay: 1000 }` + случайные
±20%), чтобы после падения внешнего сервиса ретраи не приходили одной волной. Ошибки делятся на
`RetryableError` (сеть, 5xx, 429) и `PermanentError` (валидация, 4xx, удалённая сущность) —
permanent сразу уходит в DLQ без ретраев.

**DLQ:** исчерпавшие попытки job'ы остаются в BullMQ `failed` и дублируются записью в таблицу
`dead_letter` (payload, ошибка, стектрейс, `organizationId`). Админ инстанса видит их в UI и может
переотправить. Алерт — при `failed > 0` за 15 минут.

**Идемпотентность обработчиков обязательна.** BullMQ гарантирует at-least-once, поэтому каждый
handler либо использует `jobId` = детерминированный ключ события (`outbox:<eventId>`, дедуп на
уровне очереди), либо выполняет операцию как upsert по естественному ключу. Handler, который
нельзя выполнить дважды, считается багом.

**Tenant-контекст в каждом job'е.** В payload любого job обязательно поле `organizationId`;
обёртка `runJob` открывает `withTenant(...)` перед вызовом handler'а и прокидывает
`requestId`/`causationId` в логи. Handler, обратившийся к БД мимо обёртки, падает на
предохранителе `guardedClient` — то есть ошибка обнаруживается тестом, а не утечкой.

---

## Безопасность в коде

### Пароли

`@node-rs/argon2`, алгоритм **argon2id**, параметры по базовой рекомендации OWASP:
`memoryCost: 19456` (19 MiB), `timeCost: 2`, `parallelism: 1`, `outputLen: 32`, соль 16 байт
генерируется библиотекой. Параметры выносятся в env (`ARGON2_MEMORY_COST`, `ARGON2_TIME_COST`) —
владелец мощного инстанса может поднять, владелец Raspberry Pi — нет. Хеш хранит параметры внутри
строки, поэтому при их изменении старые пароли продолжают проверяться и **прозрачно
переxешируются при следующем успешном логине**. Отвергнутая альтернатива — bcrypt (лимит 72 байта
и слабее против GPU).

### Токены и сессии

| Токен | Где живёт | TTL | Примечание |
|---|---|---|---|
| access JWT | в памяти клиента (никогда в localStorage) | 15 мин | HS256 на `JWT_SECRET`; payload: `sub`, `org`, `sid`, `role` |
| refresh | httpOnly cookie, `SameSite=Lax`, `Secure`, `Path=/api/v1/auth` | 30 дней | opaque random 32 байта, в БД хранится хеш SHA-256 |

**Ротация с reuse detection:** каждый `POST /auth/refresh` инвалидирует использованный refresh и
выдаёт новый в той же «семье» (`family_id`). Если приходит refresh, который уже был использован, —
это признак кражи: **вся семья отзывается**, все сессии пользователя закрываются, в audit log
пишется событие, пользователю уходит письмо. Отвергнутая альтернатива — долгоживущий refresh без
ротации: украденный токен работает месяц и это невозможно обнаружить.

Logout и смена пароля добавляют `sid` в Redis-денилист на остаток TTL access-токена — иначе
15 минут после выхода токен остаётся валидным. `SameSite=Lax` (не `Strict`) выбран, чтобы
переходы по ссылкам из писем-уведомлений не разлогинивали; CSRF при этом закрыт тем, что мутации
идут только с `Authorization: Bearer` (cookie сама по себе ничего не авторизует, кроме `/refresh`,
который дополнительно проверяет `Origin`).

**2FA:** TOTP через `otplib` (SHA-1, 6 цифр, окно ±1 шаг), секрет шифруется тем же AES-256-GCM,
что и остальные секреты. 10 одноразовых recovery-кодов хранятся как argon2id-хеши.

### Rate limiting

`rate-limiter-flexible` на Redis (общий счётчик для всех реплик), несколько независимых лимитов:

| Область | Ключ | Лимит |
|---|---|---|
| Логин / сброс пароля / 2FA | IP + email | 5 попыток / 15 мин, экспоненциальная задержка |
| API в целом | userId (или IP для анонимных) | 300 req / мин |
| Тяжёлые endpoint'ы (экспорт, AI, поиск) | userId | 10 / мин |
| Регистрация организации | IP | 3 / час |
| Создание приглашений | userId | 20 / 10 мин |
| Приём приглашения по ссылке | IP | 10 / 15 мин |
| Отчёты об ошибках клиента | userId (или IP для анонимных) | 10 / мин |
| WebSocket-события от клиента | socketId | 50 / с |

При срабатывании — 429 с `Retry-After` и `code: "rate_limited"`.

Приглашения считаются на приглашающего, а не на адрес: адрес выбирает вызывающий, и счётчик по нему
не ограничивает никого — двадцать приглашений на двадцать разных адресов не потратили бы и одной
попытки. Бюджет тратится **до** записи, поэтому исчерпавший его актор не может ни рассылать письма
нашим релеем, ни зондировать `user_already_exists` по списку адресов (`T-IAM-10`).

### HTTP-hardening

`helmet` с явным CSP (без `unsafe-inline`; Vite-сборка использует nonce для единственного
inline-скрипта), `HSTS` при `APP_URL` на https, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`, `frame-ancestors 'none'`.
CORS — строгий allow-list из `APP_URL` (+ `CORS_EXTRA_ORIGINS`), `credentials: true`, никаких
`origin: true`. Тело запроса ограничено 1 MB (файлы идут не через Node, а presigned-url в S3).

### Валидация входа

Всё, что приходит извне, проходит zod-схему **на границе**: body, query, params, заголовки с
семантикой, webhook-payload'ы, содержимое job'ов из очереди, ответы внешних API. Внутри границы
данные уже типобезопасны, и повторных проверок нет. Схемы лежат в `presentation/http/validators/`
(HTTP) и рядом с адаптерами (внешние ответы); общие примитивы — в `packages/shared`.
Дополнительно: `rehype-sanitize` для любого пользовательского Markdown/HTML в KB, whitelist
протоколов в ссылках (`http`, `https`, `mailto`), запрет `javascript:` и `data:` в редакторах.

### Шифрование секретов конфигурации

Интеграции хранят чужие ключи (AI-провайдеры, SMTP-пароли, GitHub-токены, webhook-секреты).
Схема хранения — одинаковая для всех:

```ts
// infrastructure/crypto/secret-box.ts
// AES-256-GCM, ключ из APP_ENCRYPTION_KEY (32 байта, base64).
export function encryptSecret(plain: string): { apiKeyEnc: string; apiKeyTail: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    // v1:<iv>:<tag>:<ciphertext> — префикс версии, чтобы пережить смену схемы/ключа
    apiKeyEnc: `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`,
    apiKeyTail: plain.slice(-4),      // только для UI: «sk-…a91f»
  };
}
```

Правила: расшифровка только в момент использования, расшифрованное значение не кладётся в
переменные модуля и не возвращается ни в одном API-ответе — наружу отдаётся исключительно
`apiKeyTail`. `APP_ENCRYPTION_KEY` обязателен при старте, если в БД есть хоть один зашифрованный
секрет. Ротация ключа — миграционным скриптом с перешифровкой (префикс `v1:` даёт возможность
поддержать `v2:` одновременно). Путь к KMS: `SecretBoxPort` уже абстрагирует шифрование, поэтому
адаптер `KmsSecretBox` (AWS KMS / Vault Transit) подключается заменой одной строки в
composition root — envelope encryption, локальный ключ становится data key.

### Редактирование секретов в логах

pino настроен с `redact` по путям: `req.headers.authorization`, `req.headers.cookie`,
`res.headers["set-cookie"]`, `*.password`, `*.token`, `*.refreshToken`, `*.apiKey`, `*.apiKeyEnc`,
`*.secret`, `*.otp`, `*.recoveryCode`. Плюс сериализатор ошибок вырезает `config.headers` из
ошибок HTTP-клиентов (иначе токен интеграции уезжает в лог со стектрейсом). Тело запроса
логируется только в `LOG_LEVEL=debug` и только для не-auth маршрутов.

---

## Конфигурация и env

Единственный вход конфигурации — переменные окружения, разобранные zod-схемой **один раз при
старте**. Ошибка конфигурации = отказ старта, а не 500 через час работы.

```ts
// infrastructure/bootstrap/env.ts
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_URL: z.url(),                                    // нужен для CORS, cookie и ссылок в письмах

  DATABASE_URL: z.url().startsWith('postgres'),
  REDIS_URL: z.url().startsWith('redis'),

  JWT_SECRET: z.string().min(32),
  APP_ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32,
    'APP_ENCRYPTION_KEY must be 32 bytes, base64-encoded'),

  S3_ENDPOINT: z.url(), S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1), S3_SECRET_KEY: z.string().min(1),
  S3_REGION: z.string().default('us-east-1'), S3_FORCE_PATH_STYLE: z.stringbool().default(true),

  SMTP_URL: z.url().optional(),                        // нет → операция отвечает 503
  MEILI_HOST: z.url().optional(),                      // нет → поиск деградирует до postgres-fts
  MEILI_MASTER_KEY: z.string().optional(),
  // AI-провайдеры настраиваются администратором организации в UI и хранятся в таблице
  // `AIProvider` (`kind`: anthropic | openai | openai_compat | openrouter, ключ — в `apiKeyEnc`).
  // В env живёт только глобальный выключатель инсталляции — ключей провайдеров в env нет.
  AI_ENABLED: z.stringbool().default(false),

  LOG_LEVEL: z.enum(['fatal','error','warn','info','debug','trace']).default('info'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),     // нет → трейсы не экспортируются
  RUN_WORKERS_IN_PROCESS: z.stringbool().default(false),
})
  .refine((e) => !e.MEILI_HOST || !!e.MEILI_MASTER_KEY,
    { message: 'MEILI_MASTER_KEY is required when MEILI_HOST is set', path: ['MEILI_MASTER_KEY'] });

export type Env = z.infer<typeof envSchema>;
export const loadEnv = (): Env => envSchema.parse(process.env);   // parse, не safeParse: падаем громко
```

**Обязательные:** `APP_URL`, `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `APP_ENCRYPTION_KEY`,
`S3_*`. **Опциональные:** `SMTP_URL`, `MEILI_*`, `AI_ENABLED`, `OTEL_*` (ключи AI-провайдеров в env не живут — только в БД, см. `AIProvider`).

`.env.example` в корне репозитория содержит все переменные с комментариями, безопасными
дефолтами для `docker compose` и явными плейсхолдерами (`CHANGE_ME_...`) для секретов.
Реальные `.env` — в `.gitignore`; секреты существуют только на сервере и никогда не попадают
в клиентский бандл (Vite пробрасывает только префикс `VITE_`, что закреплено ESLint-правилом).

**Деградация при отсутствии опционального сервиса** — приложение обязано работать:

| Сервис выключен | Что происходит |
|---|---|
| Meilisearch | `SearchPort` → `postgres-fts.adapter.ts` (`tsvector` + `pg_trgm`, permission-фильтрация та же); очередь `search-index` — no-op; в UI баннер «расширенный поиск недоступен» |
| AI | AI-функции скрыты в UI и возвращают 501 `feature_disabled`; очередь `embeddings` — no-op |
| SMTP | Операция отвечает 503 `mail_not_configured` — и в dev тоже. **Письмо в лог не пишется никогда** (правка 2026-07-28): единственное письмо ядра аутентификации несёт одноразовый токен сброса пароля внутри ссылки, и запись такого письма на уровне `info` раздаёт сброс пароля каждому, кто читает логи, — включая агрегатор, куда логи уезжают целиком. Это прямо противоречило бы `rules/observability.mdc` и разделу «Что нельзя логировать никогда». Для dev ответ — Mailpit из `docker-compose.yml`, он в профиле `default` |
| OTel | Трейсы не экспортируются, логи и метрики работают |

Здоровье выключенных сервисов не влияет на `/ready` — иначе инстанс в профиле `minimal`
никогда не станет готовым.

**Деградация, которая опциональной не является** (дополнено 2026-07-29). Две подсистемы попадают в
ту же таблицу по форме, но не по смыслу: без них приложение не деградирует, а перестаёт пускать
людей. Обе поэтому влияют на `/ready` — инстанс в таком состоянии должен выпасть из балансировки,
а не отвечать 503 на каждый вход.

| Сервис недоступен | Что происходит |
|---|---|
| **Redis** | Ограничитель попыток не может считать, а несчитаемый вход — это вход без ограничения, поэтому `/auth/{login,refresh,register}` отвечают **503 `service_unavailable`** (fail closed, `rules/security.mdc`). `/healthz` при этом жив: процесс исправен, недоступна зависимость. Симптом для оператора — «приложение отвечает, войти нельзя»; смотреть `/readyz`, поле `redis` |
| **`DATABASE_AUTH_URL` не задана** | Подключения, которое находит учётную запись до того, как известна организация, не существует — вход невозможен. При старте пишется строка `warn` **до** открытия порта, в `/readyz` появляется `authentication: disabled`, первый вход отвечает 503 `service_unavailable`. На HTTP-статус `/ready` это не влияет: инсталляция, которая переменную никогда не задавала, иначе просто не поднялась бы |

---

## Наблюдаемость

### Логи

pino в JSON, единственный транспорт — stdout (собирает Docker/systemd/loki). Обязательные поля
на каждой записи: `requestId`, `organizationId`, `userId`, `route`, `durationMs`, `statusCode`.
Контекст протаскивается **AsyncLocalStorage**, а не аргументом через все слои:

```ts
// infrastructure/logging/request-context.ts
export const requestContext = new AsyncLocalStorage<RequestContext>();

export const contextMiddleware: RequestHandler = (req, res, next) => {
  const requestId = req.header('x-request-id') ?? ulid();
  res.setHeader('x-request-id', requestId);
  requestContext.run({ requestId, organizationId: null, userId: null }, next);
};

// логгер сам подмешивает контекст, вызывающему коду ничего передавать не нужно
export const logger = pino({ level: env.LOG_LEVEL, redact: REDACTED_PATHS,
  mixin: () => requestContext.getStore() ?? {} });
```

`organizationId`/`userId` дописываются в контекст auth-middleware после аутентификации. В job'ах
контекст создаёт обёртка `runJob` (`requestId` наследуется от события, породившего job, — по
цепочке `causationId` можно проследить путь от HTTP-запроса до письма).

### Health-эндпоинты

| Endpoint | Что проверяет | Кому |
|---|---|---|
| `GET /health` | процесс жив, отвечает; без обращений к зависимостям | liveness-проба, рестарт при зависании |
| `GET /ready` | `SELECT 1` в Postgres, `PING` в Redis, флаг завершённых миграций, `shuttingDown === false` | readiness-проба, балансировщик/compose `depends_on` |

Опциональные сервисы отражаются в теле `/ready` как `{ meilisearch: "disabled" }`, но не влияют
на HTTP-статус.

### Метрики

`prom-client` на `GET /metrics` (закрыт basic-auth или сетевым доступом), RED-набор:

- `http_requests_total{method,route,status}` — Rate и Errors;
- `http_request_duration_seconds{method,route}` (histogram) — Duration, перцентили p50/p95/p99;
- `bullmq_jobs_total{queue,status}`, `bullmq_job_duration_seconds{queue}`, `bullmq_queue_depth{queue}`;
- `outbox_lag_seconds` — возраст самого старого необработанного события (главный сигнал «система
  отстаёт»);
- `db_query_duration_seconds`, `db_pool_active/idle`;
- `default metrics` Node (heap, event loop lag, GC).

`route` берётся из шаблона Express (`/api/v1/tasks/:id`), а не из URL, иначе кардинальность метрик
взрывается на id'шниках.

### Трейсы

OpenTelemetry Node SDK, автоинструментация `http`, `express`, `@prisma/instrumentation`,
`ioredis`. Экспорт OTLP, включается наличием `OTEL_EXPORTER_OTLP_ENDPOINT` — по умолчанию
выключен, чтобы self-host инстанс не тратил ресурсы. `traceId` пишется в каждую строку лога, а
`requestId` кладётся в span-атрибут: из лога можно уйти в трейс и наоборот. Сэмплирование —
`parentbased_traceidratio` 10% в проде, 100% в dev.

### Клиентские ошибки

Необработанные ошибки React (error boundary) и отклонённые промисы отправляются на
`POST /api/v1/telemetry/client-error` (rate-limit 10/мин на пользователя): сообщение,
sourcemapped-стек, `appVersion`, `route`, `requestId` последнего запроса. Ошибки пишутся в тот же
pino-лог с `source: "client"`. Внешние сервисы (Sentry и подобные) не подключаем по умолчанию —
self-host не должен слать данные наружу; интеграция возможна через env, но выключена.

---

## Тестовая стратегия

```
        ┌──────────────────────────────┐
        │  e2e (Playwright)  ~15-25    │  критичные пользовательские сценарии
        ├──────────────────────────────┤
        │  contract (openapi)  1 набор │  спека ↔ роутер, коды ошибок
        ├──────────────────────────────┤
        │  integration (Testcontainers)│  репозитории, RLS, миграции, HTTP через supertest
        ├──────────────────────────────┤
        │  application (моки портов)   │  сценарии, ветвления, ошибки
        ├──────────────────────────────┤
        │  domain (чистые юниты)       │  инварианты сущностей и ВСЕ policy
        └──────────────────────────────┘
```

| Уровень | Где живёт | Чем запускается | Что проверяет |
|---|---|---|---|
| domain | рядом с кодом: `domain/tasks/task.entity.test.ts` | Vitest, без окружения, < 1 c | инварианты, переходы состояний, **все ветки policy** |
| application | `application/tasks/use-cases/*.test.ts` | Vitest + in-memory реализации портов | оркестрация, ошибки, публикация событий в outbox |
| integration | `packages/server/test/integration/**` | Vitest + Testcontainers (Postgres 16 + pgvector), Redis в контейнере | SQL, маппинг Prisma, миграции, **RLS-изоляция**, HTTP через supertest |
| contract | `packages/server/test/contract/openapi.test.ts` | Vitest | спека ↔ роутер, коды ошибок из каталога |
| e2e | `packages/e2e/tests/**` | Playwright поверх `docker compose` | логин, 2FA, создание задачи, канбан-drag, документ, чат, поиск |
| client | рядом с компонентом | Vitest + `@testing-library/react` | хуки, схемы, критичные компоненты |

**Обязательные isolation-тесты RLS.** Testcontainers — единственный способ проверить RLS
по-настоящему: мок ORM про политики Postgres не знает. Для **каждой** таблицы с
`organization_id` генерируется тест по общему шаблону:

```ts
// packages/server/test/integration/rls/rls-isolation.test.ts
describe.each(TENANT_SCOPED_TABLES)('RLS isolation: %s', (table) => {
  it('не отдаёт строки чужой организации', async () => {
    const rowB = await seedRowFor(orgB, table);
    const rows = await withTenant(prisma, { organizationId: orgA.id, userId: userA.id },
      (tx) => tx.$queryRawUnsafe(`SELECT id FROM "${table}" WHERE id = $1`, rowB.id));
    expect(rows).toHaveLength(0);
  });

  it('не даёт обновить и удалить строку чужой организации', async () => { /* ... */ });
  it('не даёт вставить строку с чужим organization_id', async () => { /* ... */ });
});
```

`TENANT_SCOPED_TABLES` формируется **из схемы Prisma автоматически** — новая таблица с
`organizationId` сразу попадает в набор и без политики валит тесты. Это защита от главного
класса багов продукта: утечки данных между тенантами. Контейнер поднимается один на файл
(`globalSetup`), между тестами — `TRUNCATE ... CASCADE`, а не пересоздание контейнера.

**Пороги покрытия** (Vitest `coverage.thresholds`, проверяются в CI и агентом `test-coverage`):

| Область | lines | branches |
|---|---|---|
| `domain/**/access/*.policy.ts` | **100%** | **100%** |
| `domain/**` | 95% | 90% |
| `application/**` | 90% | 85% |
| `infrastructure/**`, `presentation/**` | 75% | 70% |
| весь `packages/server` | 85% | 80% |

Разработка идёт по TDD (Red → Green → Refactor): тест на поведение появляется раньше реализации,
баг чинится тестом, воспроизводящим баг.

---

## Команды

Все команды запускаются из корня репозитория; корневые скрипты — обёртки над `turbo`.

Таблица описывает то, что реально объявлено в корневом `package.json`. Команды, помеченные
«планируется», ещё не существуют — соответствующий пакет появится в указанном эпике.

| Команда | Что делает |
|---|---|
| `pnpm install` | Устанавливает зависимости всех пакетов (Corepack подтянет нужный pnpm) |
| `pnpm docker:up` | Поднимает полный dev-стек: Postgres, Redis, MinIO (+бакет), Meilisearch, Mailpit |
| `pnpm docker:up:minimal` | То же без Meilisearch и Mailpit — профиль `minimal` |
| `pnpm docker:down` | Останавливает стек во всех профилях, тома сохраняются |
| `pnpm docker:logs` | `logs -f --tail=100` по всем сервисам во всех профилях |
| `pnpm docker:reset` | **Разрушительно:** удаляет все тома и поднимает стек заново с нуля (спросит подтверждение; `--yes` пропускает) |
| `pnpm db:bootstrap` | Переприменяет роли БД, их атрибуты и пароли, а также создаёт базу, если её нет. Нужен потому, что `initdb.d` отрабатывает только на пустом томе: смена пароля роли иначе не доедет до существующей инсталляции. Выполняется через `docker compose run` (одноразовый контейнер), а не `exec`: окружение работающего контейнера зафиксировано в момент его создания, поэтому `exec` после ротации пароля в `.env` переприменил бы **старый** пароль и отрапортовал об успехе |
| `pnpm db:grants` | Переприменяет гранты по каталогу (`packages/server/prisma/sql/01-grants.sql`), идемпотентно. Запускается **после каждой миграции** и **после каждого восстановления из бэкапа**: `pg_restore --no-privileges` не оставляет от грантов ничего, а `prisma migrate deploy` их не вернёт — после восстановления у него нет pending-миграций |
| `pnpm check:services` | Smoke-проверка dev-стека: подключается теми же кредами из `.env`, что и сервер — Postgres (расширения, четыре роли и их атрибуты), Redis (`PING`), MinIO (подписанный `HeadBucket`), Meilisearch (`/health`), SMTP (баннер). Код возврата 1 только при отказе **обязательного** сервиса; отключённые опциональные помечаются `SKIPPED`. Диагностика по каждому сервису — [`../runbooks/local-environment.md`](../runbooks/local-environment.md) |
| `pnpm check:rls` | Сверяет каталог PostgreSQL (`pg_class`, `pg_policy`) с каноническим шаблоном политики и с реестром `tenant-tables.constant.ts`: `ENABLE`+`FORCE`, политика для `app_user` с `USING` **и** `WITH CHECK`, отсутствие политик на `PUBLIC`, совпадение каталога, Prisma-схемы и реестра. Строку подключения берёт из аргумента (`pnpm check:rls -- postgresql://…`) или из `DATABASE_URL`; читает только `pg_catalog`, поэтому достаточно роли `app_user`. Код возврата 1 при нарушениях, 2 если проверку не удалось выполнить. Нужен **живой** БД-хост: инструмент оператора для staging после восстановления из бэкапа, тогда как тот же аудит на миграции этого чекаута гоняет `pnpm test:integration` |
| `pnpm dev` | Preflight (`scripts/preflight.ts`: есть ли `.env`, валидна ли схема, слушают ли обязательные порты), затем параллельно: `server` (tsx watch), `client` (vite), воркеры в процессе сервера. Preflight вызывается **явно** внутри скрипта: в `.npmrc` стоит `enable-pre-post-scripts=false`, поэтому хук `predev` молча не сработал бы. Маркетинговый лендинг (`packages/landing`) сюда не входит — он поднимается отдельно: `pnpm dev:landing` |
| `pnpm build` | Сборка `shared` → `server` (tsc + tsc-alias) и `client` (vite build), с кешем turbo |
| `pnpm typecheck` | `tsc --noEmit` во всех пакетах |
| `pnpm lint` | ESLint 9 flat config + проверка запретов (`prisma.*` вне persistence, raw `fetch` на клиенте) |
| `pnpm lint:repo` | ESLint по файлам репозитория вне `packages/` (конфиги, скрипты, `test/`) |
| `pnpm format` / `pnpm format:check` | Prettier по всему репозиторию: правка / проверка без записи |
| `pnpm test` | Vitest: unit + application во всех пакетах |
| `pnpm test:repo` | Контрактные тесты репозитория: раскладка воркспейса, tsconfig, compose, `.env.example` |
| `pnpm test:integration` | Vitest integration-проект: поднимает Testcontainers, гоняет RLS и репозитории |
| `pnpm test:integration:local` | То же самое, но с `DOCKER_HOST` и `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE` из текущего docker-контекста — нужен на Colima и любом rootless-демоне |
| `pnpm test:e2e` | Playwright из `packages/e2e` поверх поднятого стека |
| `pnpm db:migrate` | `prisma migrate dev` (dev) / `prisma migrate deploy` (prod-образ) — *планируется, EPIC-003* |
| `pnpm db:seed` | Наполняет БД демо-данными, идемпотентно — *планируется, EPIC-003* |
| `pnpm api:gen` | `openapi-typescript docs/api/openapi.yaml` → `api-schema.d.ts` в клиенте — *планируется, STORY-003-05* |
| `pnpm turbo run typecheck lint build test` | **CI-before-push:** полный набор проверок одной командой |

Полное пересоздание локальной БД делается через `pnpm docker:reset` (сносит том), а не отдельной
`db:reset`: `initdb.d` в любом случае отрабатывает только на пустом томе.

`pnpm api:gen` дополнительно прогоняется в CI с проверкой `git diff --exit-code` — забытая
регенерация типов после правки спеки блокирует PR.

---

## Политика зависимостей

**Версии.** Новые пакеты добавляются в последней стабильной версии. Диапазоны — `^` для рантайм-
зависимостей, точные версии для инструментов сборки (turbo, prisma, typescript), где минорка
меняет поведение. `pnpm-lock.yaml` коммитится всегда; в CI — `pnpm install --frozen-lockfile`.
Мажорные апгрейды — отдельным PR с чтением migration guide и зелёными тестами, никогда «заодно».

**Supply-chain.** Перед добавлением или апгрейдом пакета проверяется: не входит ли он в свежие
кампании со скомпрометированными npm-пакетами, нет ли typosquatting (похожее имя на популярный
пакет), есть ли `postinstall`-скрипт и что он делает, кто мейнтейнер и не менялся ли он недавно,
живой ли проект. Инструменты: `pnpm audit`, `osv-scanner`, GitHub Advisories, `npm view <pkg>`
для истории публикаций. **Malware важнее свежести:** пакет под подозрением не обновляется, факт
фиксируется в PR. В корне включён `pnpm.onlyBuiltDependencies` — allow-list пакетов, которым
разрешены install-скрипты (по умолчанию сборочные биндинги вроде `esbuild`, `@node-rs/argon2`).

**Совместимость лицензий с AGPL-3.0.** Проект распространяется под AGPL-3.0, поэтому у каждой
зависимости проверяется лицензия. В CI работает `license-checker` с allow-list, новая лицензия
вне списка ломает сборку.

| Статус | Лицензии | Комментарий |
|---|---|---|
| Разрешено | MIT, Apache-2.0, BSD-2/3-Clause, ISC, 0BSD, Unlicense, CC0, Python-2.0, MPL-2.0 | Permissive и weak-copyleft совместимы с AGPL-3.0 |
| Разрешено с осторожностью | LGPL-2.1+/3.0, GPL-3.0, AGPL-3.0 | Совместимы, но фиксируем в ADR факт использования |
| **Запрещено** | GPL-2.0-only, любые «free for non-commercial», BSL 1.1, SSPL, Elastic License 2.0, Commons Clause, проприетарные | GPL-2.0-only несовместим с AGPL-3.0; остальные не являются open-source и делают распространение невозможным |

Отдельно зафиксировано: **FullCalendar Premium не используется** — платные плагины (resource/
timeline views) распространяются под коммерческой лицензией, несовместимой с AGPL-3.0-проектом,
который любой может форкнуть и запустить. Календарь строится на `@schedule-x/react`
(**ядро — MIT**), при этом **premium-плагины Schedule-X запрещены тем же правилом**: event modal,
drag-to-create, draw, resource view и sidebar продаются по платной лицензии «1 проект = 1 лицензия»
и не могут быть распространены в составе AGPL-репозитория. Разрешены только open-source-режимы
календаря (день/неделя/месяц/список); создание и редактирование события реализуем собственной
модалкой на Mantine поверх событий сетки. Той же логикой отсеяны Elasticsearch
(SSPL/Elastic License → выбран Meilisearch, MIT) и коммерческие data-grid'ы (используем
TanStack Table v8, MIT).

**Редактор документов — BlockNote:** ядро (`@blocknote/core`, `@blocknote/react`) под **MPL-2.0**
(в allow-list, совместимо с AGPL-3.0). Пакеты `@blocknote/xl-*` (AI, multi-column, экспортеры)
дуально лицензированы **GPL-3.0 / коммерческая**; для нашего AGPL-3.0-проекта применима ветка
GPL-3.0 — использование допускается, но каждый подключённый `xl`-пакет фиксируется в
[ADR-0012](./adr/0012-docs-editor-blocknote-json-content.md) с указанием лицензии.

**Крипто на клиенте (E2EE-vault):** источник правды — [`../security/e2ee-design.md`](../security/e2ee-design.md).
Отдельно: библиотека поставляется как WebAssembly, поэтому CSP приложения обязана содержать
`'wasm-unsafe-eval'` в `script-src` (и **никогда** `'unsafe-eval'`), а
`Cross-Origin-Embedder-Policy` не выставляется — обоснование и отвергнутые альтернативы в
[ADR-0023](./adr/0023-csp-for-wasm-crypto.md).
Он предписывает `libsodium-wrappers-sumo` как **единственную** зависимость крипто-модуля
(Argon2id `crypto_pwhash`, XChaCha20-Poly1305-IETF, `crypto_box_seal`, Ed25519). Лицензия — ISC,
для AGPL-3.0 препятствий нет. **Размер — принятое осознанное исключение (решение от 2026-07-26):**
~375 KB min+gzip (JS + WASM) против бюджета ленивого чанка ≤ 150 KB из
[`ux-architecture.md`](./ux-architecture.md). `libsodium-wrappers-sumo` остаётся: целостность одной
аудированной библиотеки с полным набором нужных примитивов важнее ~200 KB перевеса над бюджетом.
Перевес не влияет на первую загрузку приложения — чанк `units/vault/lib/crypto` грузится **лениво,
один раз, после разблокировки vault**. У чанка **отдельная строка в `size-limit`** с собственным
порогом: он сознательно выведен из-под общего бюджета ленивого чанка ≤ 150 KB, и его рост
отслеживается по этому порогу, а не по общему. Отвергнутая альтернатива (зафиксирована, чтобы не
возвращаться к ней «заодно»): WebCrypto (AES-256-GCM, HKDF, HMAC) + `@noble/curves`/`@noble/ciphers`
(MIT, аудированы, единицы KB) + WASM-Argon2id (`hash-wasm`, MIT) — отклонена, потому что меняет набор
примитивов и требует переписывания `e2ee-design.md`.

Каждая новая зависимость с нетривиальной лицензией или ролью (редактор, крипто, платежи) требует
строки в `docs/architecture/adr/` с указанием лицензии и отвергнутых альтернатив.

**Dependabot** (`.github/dependabot.yml`): еженедельные PR-ы по `npm` (сгруппированные: `dev`,
`prod-patch`, `prod-minor`; мажоры — отдельными PR), `github-actions` и `docker`. PR проходят
полный CI и не мержатся автоматически. Security-алерты GitHub включены, критичные CVE чинятся
вне очереди.

---

## Ссылки

- [`overview.md`](./overview.md) — C4-контекст, контейнеры, границы bounded contexts
- [`data-model.md`](./data-model.md) — сущности, таблицы, индексы, RLS-политики
- [`ux-architecture.md`](./ux-architecture.md) — слои клиента, FSD, состояния и навигация
- [`adr/`](./adr/) — решения по каждому пункту таблицы стека
- [`../api/openapi.yaml`](../api/openapi.yaml) — контракт API (source of truth)
