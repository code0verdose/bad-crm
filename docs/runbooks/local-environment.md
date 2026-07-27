---
doc: runbook-local-environment
project: bad-crm
updated: 2026-07-27
---

# Runbook — локальная среда разработки

Про `docker-compose.yml` в корне репозитория: что он поднимает, как к каждому сервису подключиться
руками, что делать, когда «стек поднялся, а не работает», и сколько занимает холодный старт.

**Область:** только разработка. Дистрибутивный `docker-compose.prod.yml` — отдельный файл, он
появится в [EPIC-017](../../epics/epic-017-self-host-alpha/epic.md); установка self-host описана в
[`install.md`](install.md), а бэкапы и восстановление — в [`backup-restore.md`](backup-restore.md).
Здешние `dev_…`-дефолты и опубликованные порты на сервере не применяются.

Связанные документы: [`install.md`](install.md) · [`backup-restore.md`](backup-restore.md) ·
[`upgrade.md`](upgrade.md) · [`incident.md`](incident.md) ·
[`../architecture/stack.md`](../architecture/stack.md) (раздел «Команды»)

---

## 1. Что поднимается

Приложение бежит **на хосте** (`pnpm dev`), в контейнерах — только backing-сервисы.

| Контейнер | Образ | Порт по умолчанию | Переменная порта | Том | Профиль | Без него не работает |
|---|---|---|---|---|---|---|
| `postgres` | `pgvector/pgvector:0.8.5-pg16` | 5432 | `POSTGRES_PORT` | `pgdata` | все | ничего: это источник истины |
| `redis` | `redis:8.8.1-alpine` | 6379 | `REDIS_PORT` | `redis-data` | все | очереди BullMQ, socket.io, rate-limit, отзыв сессий |
| `minio` | `minio/minio` | 9000 (API), 9001 (консоль) | `MINIO_PORT`, `MINIO_CONSOLE_PORT` | `minio-data` | все | загрузка и выдача файлов (presigned URL) |
| `minio-setup` | `minio/mc` | — | — | — | все | одноразовый: создаёт бакет `S3_BUCKET`, выходит с кодом 0 |
| `meilisearch` | `getmeili/meilisearch:v1.50.0` | 7700 | `MEILI_PORT` | `meili-data` | `default`, `full` | расширенный поиск; без него — полнотекст PostgreSQL ([ADR-0011](../architecture/adr/0011-meilisearch-permission-aware-search.md)) |
| `mailpit` | `axllent/mailpit` | 1025 (SMTP), 8025 (веб) | `MAILPIT_SMTP_PORT`, `MAILPIT_UI_PORT` | `mailpit-data` | `default`, `full` | письма; без него они пишутся в лог |

Все порты публикуются **только на `127.0.0.1`**. Docker публикует порты прямо в `iptables` и
обходит `ufw`, поэтому bind на `0.0.0.0` открыл бы базу каждого ноутбука и CI-раннера
([`../security/threat-model.md`](../security/threat-model.md), T-SH-02).

**Профили.** Compose умеет добавлять сервис в профиль, но не умеет исключать, поэтому `postgres`,
`redis` и `minio` не объявляют профиль вовсе (стартуют всегда), а `meilisearch` и `mailpit`
объявляют `profiles: [default, full]`. Практическое следствие: **голый `docker compose up -d`
поднимает `minimal`**, полный набор — это `pnpm docker:up`.

---

## 2. Команды

| Команда | Что делает |
|---|---|
| `pnpm docker:up` | Полный набор. Ждёт `healthy` у всех долгоживущих сервисов, затем прогоняет одноразовый `minio-setup` и печатает `docker compose ps` |
| `pnpm docker:up:minimal` | То же без Meilisearch и Mailpit |
| `pnpm docker:down` | Останавливает всё во всех профилях. **Тома сохраняются** |
| `pnpm docker:logs` | `logs -f --tail=100` по всем сервисам всех профилей |
| `pnpm docker:reset` | **Разрушительно:** удаляет все тома и поднимает стек заново с нуля. Спросит подтверждение; `--yes` пропускает |
| `pnpm db:bootstrap` | Переприменяет роли БД, их атрибуты и пароли, создаёт базу, если её нет |
| `pnpm db:grants` | Переприменяет гранты по каталогу (`packages/server/prisma/sql/01-grants.sql`) |
| `pnpm check:services` | Проверяет, что приложение **может пользоваться** сервисами: см. §4 |
| `pnpm dev` | Прогоняет preflight (§4), затем `turbo run dev` |

`pnpm docker:up` — обёртка, а не синоним `docker compose up --wait`: `--wait` считает падением
любой вышедший контейнер, включая `minio-setup`, который обязан выйти с кодом 0.

### Логи

```bash
pnpm docker:logs                       # всё, следом за хвостом
docker compose logs postgres           # один сервис целиком
docker compose logs --tail=50 minio    # последние 50 строк
docker compose ps                      # состояние и health каждого контейнера
```

### Сброс тома

```bash
pnpm docker:reset          # все тома: pgdata, redis-data, minio-data, meili-data, mailpit-data
```

Точечно, когда портить всё не нужно:

```bash
docker compose --profile '*' down
docker volume rm bad-crm_meili-data    # индекс производный, восстанавливается переиндексацией
pnpm docker:up
```

**`pgdata` и `minio-data` — единственные два тома с невосстановимыми данными.** `meili-data`
переигрывается из БД, `redis-data` — очереди и эфемерное состояние, `mailpit-data` — перехваченные
письма.

> **Важно про `initdb`.** Роли, база и расширения создаются скриптами
> `packages/server/prisma/sql/initdb/` **только при инициализации пустого тома `pgdata`**. На уже
> существующем томе Docker их не запускает — отсюда почти все проблемы из §5.

---

## 3. Подключение вручную

Значения берите из `.env`; ни одну из этих команд не нужно запускать с паролем в аргументах — в
`ps` он виден всем.

### PostgreSQL

```bash
# изнутри контейнера (локальный сокет, пароль не спрашивается)
docker compose exec -it postgres psql -U app_user -d bad_crm

# под ролью-владельцем схемы — миграции, DDL, гранты
docker compose exec -it postgres psql -U app_migrator -d bad_crm

# с хоста, если psql установлен: строка подключения берётся из .env
psql "$(grep '^DATABASE_URL=' .env | cut -d= -f2-)"

# на каком порту хоста слушает контейнер на самом деле
docker compose port postgres 5432
```

Полезные запросы:

```sql
SELECT extname FROM pg_extension ORDER BY 1;                       -- расширения
SELECT rolname, rolbypassrls, rolsuper FROM pg_roles               -- роли и их атрибуты
WHERE rolname LIKE 'app\_%' OR rolname = 'backup_role';
```

`app_user` обязан быть `rolbypassrls = false`: с `BYPASSRLS` он читает строки всех арендаторов, при
этом всё работает и все тесты зелёные (CLAUDE.md, инвариант 1).

### Redis

```bash
docker compose exec -T redis redis-cli PING          # -> PONG
docker compose exec -it redis redis-cli              # интерактивно
docker compose exec -T redis redis-cli INFO keyspace
```

### MinIO

Веб-консоль: <http://localhost:9001>, логин/пароль — `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` из
`.env`. Из командной строки — через тот же образ `mc`, что и инициализатор бакета:

```bash
docker compose run --rm --no-deps --entrypoint sh minio-setup -c \
  'mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc ls local'
```

### Meilisearch

```bash
curl -s http://localhost:7700/health                          # без ключа, health публичен
curl -s -H "Authorization: Bearer $(grep '^MEILI_MASTER_KEY=' .env | cut -d= -f2-)" \
     http://localhost:7700/indexes
```

### Mailpit

Веб-интерфейс: <http://localhost:8025> — там видны все письма, которые приложение «отправило».
API: `curl -s http://localhost:8025/api/v1/messages`. SMTP слушает на 1025 и принимает любые
креды без TLS — специально, чтобы nodemailer не требовал настройки.

---

## 4. Две проверки: `pnpm check:services` и preflight

`docker compose ps` отвечает на вопрос «пять контейнеров запущены?». Этого мало: Postgres бывает
`healthy` и при этом без расширений, без ролей или с ролью `app_user`, которой кто-то выдал
`BYPASSRLS`.

**`pnpm check:services`** (`scripts/check-services.ts`) отвечает на вопрос «приложение может ими
пользоваться?» — подключается теми же кредами из `.env`, что и сервер:

- **PostgreSQL** — соединение под ролью из `DATABASE_URL`; наличие `vector`, `pgcrypto`, `citext`,
  `pg_trgm`, `btree_gist`; существование `app_migrator`, `app_user`, `app_auth`, `backup_role` и их
  ключевых атрибутов (`app_user` — без `BYPASSRLS`, `backup_role` — с ним);
- **Redis** — `PING`;
- **MinIO** — `HeadBucket` бакета из `S3_BUCKET`, **подписанный** ключами из `.env`: анонимный
  запрос сказал бы «бакет есть» и ничего не сказал бы про `S3_ACCESS_KEY`/`S3_SECRET_KEY`;
- **Meilisearch** — `GET /health`;
- **SMTP** — приветственный баннер Mailpit.

Код возврата: **1, если непригоден обязательный сервис** (Postgres, Redis, MinIO). Опциональные
(Meilisearch, SMTP) выводятся как `SKIPPED`, когда профиль или конфигурация их не предполагают, и
как предупреждение, когда они настроены, но не отвечают — приложение обязано работать без них
([`../architecture/stack.md`](../architecture/stack.md), «Деградация при отсутствии опционального
сервиса»). Секретов вывод не содержит: пароль вырезается и из строк подключения, и из сообщений
драйвера.

```text
bad-crm — development services

  OK       postgres     postgres://app_user@localhost:5433/bad_crm
           · connected as app_user
           · extensions present: btree_gist, citext, pg_trgm, pgcrypto, vector
           · roles present with the expected attributes: app_migrator, app_user, app_auth, backup_role
  OK       redis        localhost:6379
  OK       minio        http://localhost:9000/bad-crm
  SKIPPED  meilisearch  http://localhost:7700 (optional)
           · the minimal profile does not start meilisearch
  SKIPPED  smtp         smtp://localhost:1025 (optional)
           · the minimal profile does not start mailpit

  3 ok, 0 failed, 2 skipped
```

**Preflight** (`scripts/preflight.ts`) — то же самое, но дешевле и раньше: `pnpm dev` вызывает его
до `turbo run dev`. Он проверяет наличие `.env`, валидность схемы окружения и то, что обязательные
порты вообще кого-то слушают, и укладывается в доли секунды. Вызывается **явно** внутри скрипта
`dev`, а не хуком `predev`: в `.npmrc` стоит `enable-pre-post-scripts=false`, и `predev` молча
никогда бы не сработал.

---

## 5. Типовые проблемы и диагностика

### 5.1 Порт занят — и стек «поднялся», но соединение уходит не туда

**Симптом.** `docker compose ps` — всё `healthy`, а `pnpm check:services` говорит, например,
`роль "app_user" не существует` (сообщение может быть на любом языке: его локализует сервер).

**Причина.** На хосте уже слушает свой PostgreSQL. Проброс порта из виртуальной машины Docker
(Colima, Docker Desktop) при занятом порте может тихо не состояться, и `localhost:5432` ведёт к
**чужому** серверу, а не к контейнеру. Ровно так это и было обнаружено при первом запуске проверки.

**Диагностика:**

```bash
docker compose port postgres 5432      # что Compose реально пробросил
lsof -nP -iTCP:5432 -sTCP:LISTEN       # кто ещё держит порт (Linux: ss -ltnp)
```

Если `lsof` показывает процесс, который не является Docker, — вы разговариваете с ним.

**Лечение.** Порт правится **одной переменной** в `.env`, compose-файл не трогается:

```bash
POSTGRES_PORT=5433
```

и следом — порт в `DATABASE_URL` и `DATABASE_MIGRATION_URL`, потому что приложение ходит с хоста.
Затем `pnpm docker:up`. То же для `REDIS_PORT`, `MINIO_PORT`, `MINIO_CONSOLE_PORT`, `MEILI_PORT`,
`MAILPIT_SMTP_PORT`, `MAILPIT_UI_PORT`.

### 5.2 Стек поднялся, а ролей нет

**Симптом.** `pnpm check:services` → `role app_user does not exist` (SQLSTATE `28000`), при этом
порт правильный.

**Причина.** Скрипты `initdb` отрабатывают только на пустом томе `pgdata`. Том, созданный до
появления `00-bootstrap-roles.sh`, ролей не получит никогда.

**Лечение:**

```bash
pnpm db:bootstrap        # идемпотентно, создаёт роли и базу на живом контейнере
pnpm check:services
```

`db:bootstrap` выполняется через `docker compose run` (одноразовый контейнер), а не `exec`:
окружение работающего контейнера зафиксировано в момент его создания, поэтому `exec` после правки
`.env` переприменил бы **старые** значения и отрапортовал об успехе.

### 5.3 Сменил пароль в `.env` — приложение не подключается

**Симптом.** `password authentication failed for user "app_user"` (SQLSTATE `28P01`).

**Причина.** Пароли ролей задаются при инициализации тома. Правка `.env` меняет то, что приложение
*предъявляет*, но не то, что записано в базе.

**Лечение:**

```bash
pnpm db:bootstrap        # переприменяет пароли всех четырёх ролей из .env
```

Если сменился **`POSTGRES_PASSWORD`** (пароль суперпользователя кластера), `db:bootstrap` сам
упадёт на аутентификации — суперпользователь тоже создаётся один раз, при `initdb`. Тогда либо
верните прежнее значение, либо смените пароль внутри контейнера, где локальный сокет доверенный:

```bash
docker compose exec -it postgres psql -U bad_crm -d bad_crm \
  -c "ALTER ROLE bad_crm PASSWORD 'значение POSTGRES_PASSWORD из .env'"
pnpm db:bootstrap
```

…либо, если локальных данных не жалко, `pnpm docker:reset`.

### 5.4 Тома от старой версии

**Симптом.** `pnpm check:services` → `missing extension(s): btree_gist`, или в базе нет объектов,
которые должны появляться при инициализации.

**Причина.** Том создан до того, как расширение добавили в `initdb/01-extensions.sql`.

**Лечение.** На ноутбуке — `pnpm docker:reset` (удалит локальные данные). Если данные нужны,
включите расширение вручную суперпользователем: `vector` не является trusted-расширением, поэтому
`CREATE EXTENSION` для него доступен только ему:

```bash
docker compose exec -T postgres psql -U bad_crm -d bad_crm \
  -c 'CREATE EXTENSION IF NOT EXISTS btree_gist'
```

На инсталляции self-host удаление тома — не вариант: см. [`upgrade.md`](upgrade.md) и
[`backup-restore.md`](backup-restore.md).

### 5.5 Бакет MinIO отсутствует или креды не подходят

**Симптом.** `bucket bad-crm does not exist` (HTTP 404) либо `MinIO rejected the signature`
(HTTP 403).

**Причина.** 404 — одноразовый `minio-setup` не отработал (например, стек поднимали голым
`docker compose up`, а не `pnpm docker:up`). 403 — `S3_ACCESS_KEY`/`S3_SECRET_KEY` в `.env`
разошлись с `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`.

**Лечение:** привести четыре переменные в соответствие и выполнить `pnpm docker:up` — он прогоняет
`minio-setup` заново, а `mc mb --ignore-existing` делает это идемпотентно.

### 5.6 `pnpm dev` падает сразу

Preflight печатает причину и способ лечения. Три случая:

| Что печатает | Что делать |
|---|---|
| `no configuration` | `cp .env.example .env`, затем сгенерировать `APP_ENCRYPTION_KEY` (`openssl rand -base64 32`) и `JWT_SECRET` (`openssl rand -base64 48`) |
| `invalid configuration` + список переменных | Исправить перечисленные переменные; список приходит из той же схемы, которую парсит сервер при старте |
| `required services are not reachable` | `pnpm docker:up`; если не помогло — `pnpm check:services` |

`.env.example` **специально** не содержит рабочего `APP_ENCRYPTION_KEY`: плейсхолдер не проходит
проверку «32 байта в base64», и это фича, а не недосмотр — инсталляция не должна работать на ключе,
лежащем в публичном репозитории.

### 5.7 Опциональный сервис не отвечает

Meilisearch и Mailpit выключены в профиле `minimal` — это `SKIPPED`, а не ошибка. Если они должны
работать, но не отвечают, `pnpm check:services` покажет предупреждение и завершится кодом 0:
приложение обязано подниматься и без них. Проверьте профиль:

```bash
grep '^COMPOSE_PROFILES=' .env       # default | minimal
docker compose --profile default ps
```

---

## 5a. Интеграционные тесты и Docker-рантайм не от Docker Desktop

`pnpm test:integration` поднимает настоящий PostgreSQL через Testcontainers — это единственное
автоматическое доказательство инварианта №1 (арендатор не видит и не пишет чужие строки), потому что
проверяемое свойство живёт в политике БД, а не в коде.

Testcontainers ищет демон по `/var/run/docker.sock`. **Docker Desktop кладёт сокет туда, colima,
podman и rancher — нет**, и симптом получается обманчивый:

```
Could not find a working container runtime strategy
```

или, если сокет нашёлся, а путь для монтирования — нет:

```
error while creating mount source path
```

Читается это как «сломан Testcontainers», хотя сломано только то, что демон лежит в другом месте.

Две переменные закрывают вопрос — подставь путь своего рантайма (`docker context inspect` покажет):

```bash
export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
pnpm test:integration
```

Первая говорит клиенту, куда подключаться. Вторая — какой путь Testcontainers должен монтировать
внутрь контейнеров, которым нужен доступ к демону; без неё пробрасывается путь хоста, которого в
контейнере не существует.

Обе перечислены в `passThroughEnv` задачи `test:integration` (`turbo.json`): turbo прогоняет задачи
с отфильтрованным окружением, и без этой записи переменные не доезжают — `pnpm --filter
@bad-crm/server test:integration` при этом работает, что читается как «turbo сломан» вместо «одну
переменную выбросили».

На CI ничего этого не нужно: раннеры GitHub отдают демон на стандартном сокете.

## 6. Замер холодного старта (контрольная точка NFR-3)

[NFR-3](../product/prd.md) требует холодного старта менее 10 минут на чистом хосте. Протокол
замера — чтобы цифры разных людей были сопоставимы:

1. `docker compose --profile '*' down --volumes --remove-orphans` — тома пустые.
2. Образы **уже вытянуты** (`docker compose --profile '*' pull`): скорость сети не является
   свойством проекта и меряется отдельно.
3. `pnpm install --frozen-lockfile` с прогретым store pnpm.
4. `/usr/bin/time -p pnpm docker:reset --yes` — от пустых томов до всех `healthy` плюс созданный
   бакет.
5. `/usr/bin/time -p npx turbo run build --force` — сборка без кеша turbo.
6. `pnpm check:services` — стек пригоден к работе.

Повторить трижды, записать медиану.

**Замер от 2026-07-27** (Apple M4, 16 GB, macOS 24.6, Colima + Docker 29.2.1, образы в кеше):

| Шаг | Медиана |
|---|---|
| `pnpm install --frozen-lockfile` (store прогрет) | 0,7 с |
| `pnpm docker:reset --yes` (пустые тома → всё `healthy` + бакет) | 7,6 с |
| `pnpm docker:up` (тома на месте) | 1,7 с |
| `npx turbo run build --force` | 1,4 с |
| `pnpm check:services` | 0,6 с |
| preflight внутри `pnpm dev` | 0,3 с |

Суммарно от `git clone` до работающего стека — **порядка 15 секунд плюс время скачивания образов**
(≈ 700 МБ на первый раз). Запас до норматива NFR-3 — двукратный даже с учётом сети на медленном
канале; повторить замер нужно, когда в стек добавится контейнер приложения
([EPIC-017](../../epics/epic-017-self-host-alpha/epic.md)), потому что там появятся сборка образа и
шаг миграций.

---

## 7. Что дальше

- Установка self-host — [`install.md`](install.md).
- Бэкапы и восстановление, в том числе почему дамп снимается ролью `backup_role` —
  [`backup-restore.md`](backup-restore.md).
- Обновление инсталляции — [`upgrade.md`](upgrade.md).
- Инциденты безопасности — [`incident.md`](incident.md).
- Модель изоляции арендаторов, роли и гранты — [`../security/rls-design.md`](../security/rls-design.md).
