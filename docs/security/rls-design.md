---
doc: rls-design
project: bad-crm
updated: 2026-07-26
---

# Изоляция арендаторов на PostgreSQL RLS

Рабочая спецификация подсистемы мульти-тенантной изоляции Bad CRM. Модель данных и список
сущностей с метками **[T]**/**[G]** — в [`../architecture/data-model.md`](../architecture/data-model.md);
слои сервера, обёртка `withTenant` и тестовая стратегия — в
[`../architecture/stack.md`](../architecture/stack.md); границы доверия —
в [`../architecture/overview.md`](../architecture/overview.md). Здесь — SQL, код, автоматизация
и тесты, то есть то, что реально выполняется.

Документ описывает **только изоляцию организаций**. Права внутри организации (роли, ACL,
приватные проекты, vault-мембершипы) — в [`permission-model.md`](./permission-model.md).

---

## Зачем RLS, а не только код

**Модель угроз.** Основной противник здесь — не внешний злоумышленник, а собственный код.
В системе ~95 доменных таблиц с `organization_id`, десятки списочных эндпоинтов, отчёты с ручным
SQL, полнотекст, агрегаты, фоновые джобы и импорт. Каждый из этих путей строит `WHERE`, и
вероятность того, что за жизнь продукта ни в одном не будет забыт фильтр по тенанту, равна нулю:
забывают в новом эндпоинте, в динамическом фильтре, в сыром SQL для дашборда, в джобе, который
обрабатывает пачку «по всем сразу», в JOIN, где отфильтрована левая таблица, но не правая. Без
второго рубежа цена такой ошибки — компания A видит сделки, ставки, переписку и файлы компании B,
и узнаёт об этом раньше нас. С RLS та же ошибка даёт пустой результат либо ошибку БД: баг
превращается из инцидента с утечкой в обычный баг. Именно поэтому RLS в этом проекте — не
«галочка по best practice», а условие, при котором мы вообще имеем право продавать self-hosted
мульти-тенант.

**Чего RLS не решает и на что не надо на неё рассчитывать.** RLS отвечает ровно на один вопрос —
«принадлежит ли строка моей организации». Она не отвечает на «имеет ли этот сотрудник право
видеть эту задачу», «состоит ли он в приватном проекте», «выдан ли ему доступ к vault» — это
policy-слой домена. Она не защищает от суперпользователя, от владельца инсталляции и от того, кто
имеет доступ к диску или бэкапу. Она не спасает от логической ошибки в самой политике (`USING (true)`
выглядит невинно и открывает всё). Она не отменяет валидацию входа: SQL-инъекция под `app_user`
остаётся инъекцией — она ограничена одним тенантом, но внутри него читает всё, минуя policy-слой.
И она не помогает там, где данные уже покинули БД: индекс Meilisearch, кеш в Redis, эмбеддинги,
логи и S3 изолируются собственными механизмами, а не Postgres.

Разделение, которое надо держать в голове постоянно:
**RLS — стена между организациями, policy-слой — двери внутри организации.**

---

## Роли и права БД

### Четыре роли и почему именно четыре

| Роль | Кто под ней ходит | RLS | Владение |
|---|---|---|---|
| `app_user` | процесс приложения (HTTP + воркеры), 99 % запросов | **подчиняется**, `BYPASSRLS` нет | ничем не владеет |
| `app_migrator` | `prisma migrate deploy`, обслуживание партиций, ручные операции | владелец схемы и таблиц → **поэтому `FORCE`** | владеет схемой `public` и всеми объектами |
| `app_auth` | логин/refresh до определения организации; владелец `SECURITY DEFINER`-функций | `BYPASSRLS` | владеет функциями-резолверами |
| `backup_role` | только `pg_dump` и снятие контрольных счётчиков строк | `BYPASSRLS` | ничем не владеет, прав на запись нет |

Смысл разделения: роли с `BYPASSRLS` не имеют прав на запись ни в одну доменную таблицу.
У `app_auth` поверхность ограничена несколькими функциями с фиксированной сигнатурой; у
`backup_role` — правом `SELECT`, выдаваемым таблице за таблицей. Роль, которая ходит в доменные
таблицы на запись (`app_user`), обойти RLS не может ни при каких условиях, включая SQL-инъекцию.
Роль, которая может всё (`app_migrator`), в рантайме приложения не используется вообще.

**Почему бэкапу нужна собственная роль, а не `app_migrator`.** При `FORCE ROW LEVEL SECURITY`
политики применяются и к владельцу таблиц, поэтому `pg_dump` под `app_migrator` либо падает, либо —
с `--enable-row-security` — выгружает **частичные** данные: формально успешный дамп правдоподобного
размера, в котором строк меньше, чем было. Обнаруживается это при восстановлении после аварии.
Процедура — [`../runbooks/backup-restore.md`](../runbooks/backup-restore.md).

**И почему `BYPASSRLS` тут недостаточно.** `BYPASSRLS` снимает применение *политик*, но не отменяет
проверку *грантов*: без `GRANT SELECT` на таблицу `pg_dump` под `backup_role` получит
`42501 permission denied`. `ALTER DEFAULT PRIVILEGES` запрещён (см. ниже), поэтому строка
`GRANT SELECT ON <table> TO backup_role;` входит в канонический шаблон новой таблицы наравне с
`ENABLE`/`FORCE`/`POLICY`. Забыть её — значит тихо потерять таблицу из бэкапа.

### Bootstrap: создание ролей и базы

Выполняется один раз суперпользователем при инициализации инсталляции. Это **не** Prisma-миграция:
Prisma ходит под `app_migrator`, который к моменту первой миграции уже должен существовать.
Файл — `packages/server/prisma/sql/00-bootstrap-roles.sql`, в docker-compose монтируется в
`/docker-entrypoint-initdb.d/`.

```sql
-- 00-bootstrap-roles.sql · выполняется суперпользователем, идемпотентен
\set ON_ERROR_STOP on

-- Создание только создаёт. Все атрибуты переутверждаются ниже безусловно.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_migrator') THEN
    CREATE ROLE app_migrator LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user     LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_auth') THEN
    CREATE ROLE app_auth     LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backup_role') THEN
    CREATE ROLE backup_role  LOGIN;
  END IF;
END $$;

-- Атрибуты выставляются на КАЖДОМ прогоне, а не только при создании, и это принципиально.
-- Managed-инстанс переиспользуют: роли могут уже существовать, созданные прошлой инсталляцией
-- или руками. Условный `CREATE ROLE … NOINHERIT BYPASSRLS` в этом случае молча пропускается и
-- рапортует об успехе, а app_user остаётся с тем, что у него было, — с INHERIT, возможно с
-- BYPASSRLS и с членством в app_migrator. Это работающий `SET ROLE app_migrator` и полное
-- отсутствие изоляции на инсталляции, чей bootstrap не напечатал ни одной ошибки.
ALTER ROLE app_migrator LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS;
ALTER ROLE app_user     LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS;
ALTER ROLE app_auth     LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION   BYPASSRLS;
ALTER ROLE backup_role  LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION   BYPASSRLS;

-- Членства, выданные прошлой инсталляцией, снимаются здесь: NOINHERIT сам по себе только отменяет
-- автоматическое применение прав — членом можно оставаться и получить их через SET ROLE.
-- Обход по pg_auth_members, а не двенадцать `REVOKE a FROM b`: у последних каждый холостой вызов
-- печатает WARNING, и чистая установка заканчивалась бы двенадцатью предупреждениями.
DO $memberships$
DECLARE
  membership record;
BEGIN
  FOR membership IN
    SELECT granted.rolname AS granted_role, member.rolname AS member_role
    FROM   pg_auth_members am
    JOIN   pg_roles granted ON granted.oid = am.roleid
    JOIN   pg_roles member  ON member.oid  = am.member
    WHERE  granted.rolname IN ('app_migrator', 'app_user', 'app_auth', 'backup_role')
      AND  member.rolname  IN ('app_migrator', 'app_user', 'app_auth', 'backup_role')
  LOOP
    EXECUTE format('REVOKE %I FROM %I', membership.granted_role, membership.member_role);
    RAISE WARNING 'снято членство % в %', membership.member_role, membership.granted_role;
  END LOOP;
END $memberships$;

ALTER ROLE app_migrator PASSWORD
  :'migrator_pw';
ALTER ROLE app_user     PASSWORD
  :'app_pw';
ALTER ROLE app_auth     PASSWORD
  :'auth_pw';
ALTER ROLE backup_role  PASSWORD
  :'backup_pw';
```

```sql
-- база принадлежит мигратору, PUBLIC не имеет к ней ничего
CREATE DATABASE bad_crm OWNER app_migrator;
REVOKE ALL ON DATABASE bad_crm FROM PUBLIC;
GRANT CONNECT ON DATABASE bad_crm TO app_user, app_auth, backup_role;
```

```sql
-- \c bad_crm  · дальше внутри базы
ALTER SCHEMA public OWNER TO app_migrator;
REVOKE ALL   ON SCHEMA public FROM PUBLIC;      -- в PG15+ CREATE у PUBLIC уже снят, но фиксируем явно
GRANT  USAGE ON SCHEMA public TO app_user, app_auth, backup_role;

CREATE EXTENSION IF NOT EXISTS pgcrypto;        -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;          -- User.email
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;
```

Ресурсные лимиты вешаются на роль, а не на приложение — тогда они действуют и для случайного
`psql`, и для забытого скрипта:

```sql
ALTER ROLE app_user     SET statement_timeout                    = '5s';
ALTER ROLE app_user     SET idle_in_transaction_session_timeout  = '10s';
ALTER ROLE app_user     SET lock_timeout                         = '3s';
ALTER ROLE app_user     SET search_path                          = public;

ALTER ROLE app_auth     SET statement_timeout                    = '3s';
ALTER ROLE app_auth     SET idle_in_transaction_session_timeout  = '10s';
ALTER ROLE app_auth     SET search_path                          = public;

ALTER ROLE app_migrator SET statement_timeout                    = 0;      -- миграции бывают долгими
ALTER ROLE app_migrator SET lock_timeout                         = '5s';   -- но ждать блокировку не должны
ALTER ROLE app_migrator SET search_path                          = public;
```

`idle_in_transaction_session_timeout` тут — не про производительность, а про безопасность:
интерактивная транзакция с выставленным `app.organization_id` не должна висеть открытой, занимая
соединение с чужим контекстом, если процесс приложения завис.

### Почему приложение не ходит под владельцем

Три независимые причины, каждой достаточно:

1. **`FORCE ROW LEVEL SECURITY` — не единственная защита от владельца, а компенсация.** Если
   забыть `FORCE` хотя бы на одной таблице (а это одна строка в одной миграции), под владельцем
   политика этой таблицы просто перестаёт существовать. Молча. Ни ошибки, ни лога — просто
   `SELECT` возвращает все организации.
2. **Владелец может изменить политику.** Роль, под которой работает приложение, не должна иметь
   права `ALTER TABLE ... DISABLE ROW LEVEL SECURITY` или `DROP POLICY`. Иначе SQL-инъекция
   превращается из «утечка внутри тенанта» в «утечка всей базы одной строкой».
3. **Разделение отвечает на вопрос «кто это сделал».** DDL в проде выполняется только под
   `app_migrator`, значит любое изменение схемы — это деплой, а не рантайм.

Проверка при старте — обязательна, иначе ошибка конфигурации `DATABASE_URL` (а её сделать легко:
скопировали строку из миграционного окружения) остаётся незамеченной до первой утечки:

```ts
// infrastructure/persistence/prisma/assert-db-role.ts
interface RoleProbe {
  current_user: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
  can_become_migrator: boolean;
}

export async function assertRuntimeDbRole(prisma: PrismaClient): Promise<void> {
  const [probe] = await prisma.$queryRaw<RoleProbe[]>`
    SELECT current_user::text                       AS current_user,
           r.rolsuper,
           r.rolbypassrls,
           pg_has_role(current_user, 'app_migrator', 'MEMBER') AS can_become_migrator
    FROM   pg_roles r
    WHERE  r.rolname = current_user
  `;

  const problems: string[] = [];
  if (probe.current_user !== 'app_user') problems.push(`ожидалась роль app_user, получена ${probe.current_user}`);
  if (probe.rolsuper)                    problems.push('роль является суперпользователем');
  if (probe.rolbypassrls)                problems.push('роль имеет BYPASSRLS — политики не применяются');
  if (probe.can_become_migrator)         problems.push('роль может выполнить SET ROLE app_migrator');

  if (problems.length > 0) {
    throw new Error(`DATABASE_URL указывает на небезопасную роль: ${problems.join('; ')}`);
  }
}
```

**Режим `MEMBER`, а не `USAGE` — это не придирка, а разница между работающей проверкой и
декоративной.** `pg_has_role(..., 'USAGE')` отвечает «права роли действуют автоматически», то есть
требует членства **и** `INHERIT`. Все наши роли создаются `NOINHERIT` (в этом и смысл), поэтому у
`app_user`, которому по ошибке выдали `GRANT app_migrator TO app_user`, `USAGE` вернёт `false` — а
`SET ROLE app_migrator` при этом отработает. Проверено на PostgreSQL 16.14:

```
 usage_check | member_check | app_user_inherits
-------------+--------------+-------------------
 f           | t            | f
```

и в той же сессии `SET ROLE app_migrator;` → `current_user = app_migrator`. `MEMBER` отвечает на
нужный вопрос: «может ли эта роль стать той ролью», прямо или через цепочку членств.

Вызывается в `main.ts` до `app.listen` и до старта воркеров. Отказ старта — правильное поведение:
инстанс, который не может гарантировать изоляцию, не должен принимать трафик.

### Права на таблицы: явный `GRANT`, никаких `ALTER DEFAULT PRIVILEGES`

Соблазн написать один раз

```sql
-- ТАК МЫ НЕ ДЕЛАЕМ
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
```

велик, но это ровно тот механизм, который превращает забытую политику в утечку. Разберём оба
сценария «разработчик добавил таблицу и забыл про RLS»:

- **С default privileges:** новая таблица сразу читается `app_user`, RLS выключен → приложение
  работает, тесты (если для новой таблицы их ещё не написали) зелёные, данные всех организаций
  видны всем. Ошибка **тихая**.
- **Без default privileges:** новая таблица не имеет ни одного гранта для `app_user` → первый же
  запрос падает с `42501 permission denied for table X`. Ошибка **громкая**, ловится локально
  за минуту, и разработчик идёт в чек-лист, где `GRANT` стоит рядом с `ENABLE`/`FORCE`/`POLICY`.

Мы сознательно выбираем громкий отказ. Цена — четыре строки в каждой миграции с новой таблицей;
они всё равно там нужны (см. канонический шаблон).

Отдельно снимаются права на журнальных таблицах — приложение не должно уметь переписывать
собственный аудит:

```sql
-- append-only: только вставка и чтение
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs         FROM app_user;
REVOKE UPDATE, DELETE, TRUNCATE ON activity_events    FROM app_user;
REVOKE UPDATE, DELETE, TRUNCATE ON vault_access_logs  FROM app_user;
REVOKE UPDATE, DELETE, TRUNCATE ON secure_link_views  FROM app_user;
```

`TRUNCATE` не выдаётся **никогда и никому** кроме владельца: `TRUNCATE` игнорирует RLS полностью —
политики к нему не применяются, и одна команда стирает данные всех организаций.

**Последовательности следуют за своей таблицей.** `app_user` получает `USAGE, SELECT` на
последовательность только если её владеющая таблица (`pg_depend` → `pg_class`) сама попала под грант;
на остальные — `REVOKE ALL`, включая последовательность без владеющей таблицы. Раздача `USAGE` всем
подряд выглядит безобидно и таковой не является: `USAGE` на чужой последовательности позволяет
двигать её через `nextval()`, а `SELECT` читает `last_value` — то есть косвенно оценивает объём
данных в таблице, которую приложение открыть не может. `backup_role` при этом сохраняет `SELECT` на
**всех** последовательностях: `pg_dump` читает `last_value` из каждой и падает на первой недоступной.
Реализация — `prisma/sql/01-grants.sql`, проверка обеих сторон правила —
`test/integration/db/sequence-grants.test.ts` и `test/infra/grants-sql.test.ts`.

### `DATABASE_URL` для каждой роли

```dotenv
# .env.example (фрагмент)

# рантайм приложения: HTTP + воркеры. Единственная строка, попадающая в контейнер приложения.
DATABASE_URL="postgresql://app_user:${APP_DB_PASSWORD}@postgres:5432/bad_crm?schema=public&connection_limit=20&pool_timeout=10"

# путь логина/refresh: отдельный маленький пул, отдельные креды.
DATABASE_AUTH_URL="postgresql://app_auth:${AUTH_DB_PASSWORD}@postgres:5432/bad_crm?schema=public&connection_limit=4&pool_timeout=5"

# миграции. В контейнере приложения ОТСУТСТВУЕТ: подставляется job'ом деплоя / entrypoint-скриптом
# и снимается сразу после `prisma migrate deploy`.
DATABASE_MIGRATION_URL="postgresql://app_migrator:${MIGRATOR_DB_PASSWORD}@postgres:5432/bad_crm?schema=public&connection_limit=2"
```

Правила, вытекающие из этой раскладки:

- В `schema.prisma` — `url = env("DATABASE_URL")`, а в блоке миграций
  `directUrl = env("DATABASE_MIGRATION_URL")`. Prisma использует `directUrl` для `migrate`/`db push`
  и `url` для рантайма.
- `prisma migrate dev` требует shadow-базу и, следовательно, `CREATEDB` — этого права у
  `app_migrator` нет. В dev это решается явным `shadowDatabaseUrl` на отдельную локальную базу;
  в проде используется только `migrate deploy`, которому shadow-база не нужна.
- Три роли — три пула: `PrismaClient` для `app_user`, отдельный тонкий клиент для `app_auth`,
  и никакого постоянного клиента для `app_migrator` в процессе приложения. Суммарный
  `connection_limit` всех реплик обязан помещаться в `max_connections` Postgres.

### `SET ROLE` против отдельных соединений

Альтернатива, которую мы отвергаем: подключаться одной ролью и переключаться через
`SET ROLE app_user` / `RESET ROLE`.

- `SET ROLE` обратим. Всё, что умеет выполнить SQL (инъекция, неаккуратный `$queryRawUnsafe`,
  сторонняя библиотека с сырым запросом), выполнит и `RESET ROLE`, вернувшись к привилегированной
  роли. Это делает изоляцию декоративной.
- Роль, из которой можно сделать `SET ROLE app_user`, по определению является членом `app_user`
  или суперпользователем — то есть в системе появляется учётка, которой видно всё. Мы такую не
  заводим вовсе; это проверяется при старте (`pg_has_role`).
- В связке с пулером `SET ROLE` живёт до конца соединения (как обычный `SET`) и утекает на
  следующий запрос ровно так же, как утекал бы `SET app.organization_id` без `LOCAL`.
- Единственный законный «переключатель роли» в системе — `SECURITY DEFINER`-функция: она меняет
  эффективного пользователя ровно на время своего тела, с фиксированной сигнатурой и
  фиксированным `search_path`, и вернуться из неё в привилегированный контекст нельзя.

Отдельные соединения дороже на два пула и три пароля. Это единственная цена.

---

## Канонический шаблон политики

### Шаблон для новой [T]-таблицы

Пять блоков, все обязательны, порядок фиксирован. Пример — `tasks`, но текст одинаков для всех
~95 таблиц с точностью до имени.

```sql
-- 1. Включаем RLS. Без этого политики существуют, но не применяются.
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;

-- 2. Распространяем RLS на владельца таблицы (app_migrator).
--    Без FORCE владелец политику игнорирует — и любое подключение владельцем
--    (ошибка в DATABASE_URL, ручной psql, скрипт обслуживания) видит все организации.
ALTER TABLE tasks FORCE ROW LEVEL SECURITY;

-- 3. Изоляция арендатора для прикладной роли.
CREATE POLICY tenant_isolation ON tasks
  AS PERMISSIVE
  FOR ALL
  TO app_user
  USING      (organization_id = current_setting('app.organization_id')::uuid)
  WITH CHECK (organization_id = current_setting('app.organization_id')::uuid);

-- 4. Обслуживание: владелец видит строки только в явно объявленном режиме.
CREATE POLICY maintenance_access ON tasks
  AS PERMISSIVE
  FOR ALL
  TO app_migrator
  USING      (current_setting('app.maintenance', true) = 'on')
  WITH CHECK (current_setting('app.maintenance', true) = 'on');

-- 5. Права. Явно, без ALTER DEFAULT PRIVILEGES.
GRANT SELECT, INSERT, UPDATE, DELETE ON tasks TO app_user;

-- 6. Право на чтение для бэкапа. BYPASSRLS у backup_role снимает политики, но НЕ снимает проверку
--    грантов, а ALTER DEFAULT PRIVILEGES у нас запрещён. Без этой строки pg_dump получит
--    `42501 permission denied for table tasks` — или, если дамп снимается без ON_ERROR_STOP,
--    просто не привезёт таблицу. Тихая потеря данных в бэкапе, обнаруживаемая при восстановлении.
GRANT SELECT ON tasks TO backup_role;

-- Отдельный случай — служебная таблица Prisma. Её создаёт не миграция, а сам Prisma, поэтому
-- строки выше её не покрывают; при этом версия схемы обязана попасть в дамп, иначе восстановление
-- нечем сверить. Без гранта `psql -U backup_role -c 'SELECT … FROM _prisma_migrations'` в скрипте
-- бэкапа даёт 42501 и роняет бэкап целиком (`set -euo pipefail`), а проверка 4g считает таблицу
-- нарушением. Отдельной строки в миграции для неё нет и быть не может: `01-grants.sql` обходит
-- каталог и выдаёт `GRANT SELECT … TO backup_role` каждой таблице схемы `public`, включая эту.
```

Строки 5–6 остаются в шаблоне миграции: они делают новую таблицу корректной сразу, в том же
изменении, где она появляется, и читаются как утверждение о том, кому таблица доступна. Но
**источник истины по грантам — `packages/server/prisma/sql/01-grants.sql`**: он обходит каталог,
раздаёт те же права по правилам и запускается после каждой миграции и после каждого восстановления.
Причина — в том, что `pg_restore --no-privileges` не оставляет от грантов ничего, а переприменить их
прогоном миграций нельзя: `prisma migrate deploy` после восстановления не видит ни одной pending-
миграции и честно выходит с нулём, ничего не сделав.

Построчно:

| Строка | Что делает | Что сломается без неё |
|---|---|---|
| `ENABLE ROW LEVEL SECURITY` | включает механизм для таблицы | политики лежат в каталоге и не применяются; утечка полная и тихая |
| `FORCE ROW LEVEL SECURITY` | применяет политики и к владельцу | подключение владельцем (или под ролью-владельцем по ошибке конфига) обходит изоляцию |
| `AS PERMISSIVE` | режим по умолчанию, пишем явно | ничего, но явность важна: несколько PERMISSIVE-политик объединяются по **OR** (см. ловушку ниже) |
| `FOR ALL` | одна политика на `SELECT/INSERT/UPDATE/DELETE` | придётся писать четыре, и легко забыть одну |
| `TO app_user` | политика адресована конкретной роли | политика `TO PUBLIC` применится и к `app_migrator`, обесценив блок 4 |
| `USING` | какие строки **видны** (`SELECT`, `UPDATE`, `DELETE`) | видны чужие |
| `WITH CHECK` | какие строки **допустимо записать** (`INSERT`, новая версия строки в `UPDATE`) | можно вставить строку с чужим `organization_id` и «переложить» свою строку в соседнюю организацию |
| `GRANT … TO app_user` | даёт роли право обращаться к таблице | `42501 permission denied` — громкий и правильный отказ |
| `GRANT SELECT … TO backup_role` | пускает `pg_dump` в таблицу | таблицы нет в бэкапе; отказ громкий, но виден только тому, кто читает лог бэкапа |

**Про `WITH CHECK` и одну неочевидную деталь PostgreSQL.** Если у политики указан `USING` и не
указан `WITH CHECK`, PostgreSQL использует выражение `USING` в качестве проверки записи. То есть
формально политика `FOR ALL` только с `USING` вставку чужой строки уже не пропустит. Мы всё равно
пишем `WITH CHECK` явно, и это не педантизм:

- как только политика разбивается по командам (append-only таблицы, см. ниже), автоподстановка
  исчезает: у `FOR SELECT`-политики `WITH CHECK` вообще не бывает, а `FOR INSERT`-политика
  обязана иметь `WITH CHECK` и не может иметь `USING`. Правило «всегда пишем оба» переживает такой
  рефакторинг, правило «Postgres подставит» — нет;
- в каталоге (`pg_policy.polwithcheck`) неявная проверка выглядит как `NULL`. Наш CI-чек не может
  отличить «автор положился на автоподстановку» от «автор забыл». Явное выражение делает инвариант
  машинно-проверяемым — а это единственный способ удержать его на 95 таблицах;
- ревьюер читает политику как утверждение о поведении, а не восстанавливает его из документации.

**Ловушка: PERMISSIVE-политики складываются по OR.** Через полгода кто-то добавит на `tasks`
политику «шаренные задачи видны всем» — и она **расширит** доступ, а не сузит, потому что
несколько PERMISSIVE-политик объединяются дизъюнкцией. Правило проекта: любая дополнительная
политика на [T]-таблице либо содержит в себе предикат тенанта, либо объявляется
`AS RESTRICTIVE` (RESTRICTIVE-политики соединяются по AND). CI-чек ловит появление новой
PERMISSIVE-политики с неканоническим предикатом и валит сборку — **для любой роли**, а не только
для `app_user`: OR действует внутри роли, поэтому широкая PERMISSIVE-политика для `app_migrator`
молча возвращает владельцу все организации, ничего не меняя для приложения. Единственное
исключение — канонический `maintenance_access`.

Опциональное усиление для параноидального режима — по одной RESTRICTIVE-политике на таблицу:

```sql
CREATE POLICY tenant_context_required ON tasks
  AS RESTRICTIVE FOR ALL TO app_user
  USING      (current_setting('app.organization_id', true) IS NOT NULL)
  WITH CHECK (current_setting('app.organization_id', true) IS NOT NULL);
```

Она ничего не меняет в нормальной работе, но делает так, что даже ошибочно добавленная
широкая PERMISSIVE-политика не сработает без tenant-контекста. Цена — вторая политика на таблицу
и чуть более длинный `EXPLAIN`. По умолчанию не включаем; включаем, если инсталляция обслуживает
организации разных юрлиц с регуляторными требованиями.

### Особый случай: `organizations`

У корня тенанта нет колонки `organization_id` — политика строится по собственному ключу:

```sql
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_self ON organizations
  AS PERMISSIVE FOR ALL TO app_user
  USING      (id = current_setting('app.organization_id')::uuid)
  WITH CHECK (id = current_setting('app.organization_id')::uuid);

GRANT SELECT, INSERT, UPDATE ON organizations TO app_user;   -- DELETE не выдаём: удаление организации — операция app_migrator
```

Отсюда следует неочевидное правило регистрации: **идентификатор новой организации генерирует
приложение, а не БД**, и создание идёт внутри `withTenant` с этим самым id.

```ts
const organizationId = uuidv7();
await withTenant(prisma, { organizationId, userId: null }, async (tx) => {
  await tx.organization.create({ data: { id: organizationId, slug, name, /* … */ } });
  await tx.user.create({ data: { organizationId, email, passwordHash, /* … */ } });
  await tx.role.createMany({ data: systemRoles(organizationId) });
});
```

Если этого не сделать, `INSERT` в `organizations` упадёт на `WITH CHECK`: контекста нет, значит
`current_setting` бросит ошибку. Это правильное поведение — «создать организацию, не зная какую»
не должно быть возможно, — но диагностируется тяжело, если про правило не знать.

### Особый случай: append-только журналы

Там, где приложению запрещено изменять и удалять строки, политика разбивается по командам —
чтобы каталог отражал реальное намерение, а не «есть политика на всё, но грантов нет»:

```sql
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_select ON audit_logs
  AS PERMISSIVE FOR SELECT TO app_user
  USING (organization_id = current_setting('app.organization_id')::uuid);

CREATE POLICY tenant_insert ON audit_logs
  AS PERMISSIVE FOR INSERT TO app_user
  WITH CHECK (organization_id = current_setting('app.organization_id')::uuid);

CREATE POLICY maintenance_access ON audit_logs
  AS PERMISSIVE FOR ALL TO app_migrator
  USING      (current_setting('app.maintenance', true) = 'on')
  WITH CHECK (current_setting('app.maintenance', true) = 'on');

GRANT  SELECT, INSERT            ON audit_logs TO app_user;
REVOKE UPDATE, DELETE, TRUNCATE  ON audit_logs FROM app_user;
```

Два независимых рубежа для одного правила: нет гранта (`REVOKE`) и нет политики (`FOR UPDATE`
отсутствует). Снятие любого из них по отдельности аудит не откроет.

Синтаксическая шпаргалка, чтобы не путать:

| Команда | Применяется `USING` | Применяется `WITH CHECK` |
|---|---|---|
| `SELECT` | да | — (указывать нельзя) |
| `INSERT` | — (указывать нельзя) | да |
| `UPDATE` | да (какие строки можно взять) | да (какой стала строка) |
| `DELETE` | да | — |

### Партиционированные таблицы (`audit_logs`)

`audit_logs` партиционирована по месяцам. Здесь два факта, которые надо знать точно:

1. Политики и `ENABLE/FORCE` **не наследуются** партициями. При обращении через родителя
   применяются политики родителя; при обращении напрямую к партиции — только её собственные
   (которых нет).
2. Гранты тоже не наследуются: `GRANT` на родителя не даёт прав на партицию.

Отсюда рабочее правило: **партиции не получают никаких грантов, кроме `GRANT SELECT … TO
backup_role`**. Приложение обращается только к родительской таблице, поэтому у `app_user` на листе
нет и не должно быть ничего; CI-чек 4c отдельно проверяет, что ни у одной партиции нет прав
`app_user`. Дополнительно партиции получают `ENABLE`/`FORCE` — как страховка на случай, если грант
когда-то появится по ошибке.

**Исключение для `backup_role` — не послабление, а условие существования бэкапа.** `pg_dump`
выгружает партиционированную таблицу полистно и проверяет права на листе; грант родителя на лист не
распространяется, а `BYPASSRLS` тут не помогает — это грант, а не политика. Партиция без
`GRANT SELECT` для `backup_role` роняет **весь** дамп, ещё до чтения первой строки:

```
pg_dump: error: query failed: ERROR:  permission denied for table audit_logs_2026_07
pg_dump: detail: Query was: LOCK TABLE public.tasks, public.audit_logs, public.audit_logs_2026_07 …
```

То есть `audit_logs` — единственная таблица, ради которой бэкап нужен при разборе инцидента, — либо
роняет бэкап (`set -euo pipefail`), либо, если бэкап снимается без остановки на ошибке, тихо в него
не попадает.

```sql
-- вызывается джобом обслуживания партиций под app_migrator
CREATE TABLE audit_logs_2026_08 PARTITION OF audit_logs
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

ALTER TABLE audit_logs_2026_08 ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs_2026_08 FORCE  ROW LEVEL SECURITY;

-- Единственный грант, который партиция получает. app_user не получает ничего.
GRANT SELECT ON audit_logs_2026_08 TO backup_role;
```

Джоб обслуживания партиций обязан выполнить эту строку — либо, что надёжнее, вызвать после себя
`01-grants.sql` (см. ниже), который раздаёт её по каталогу и не забывает.

### Таблицы, у которых `organization_id` «есть только через родителя»

Классический пример — `task_labels` (`task_id` + `label_id`), где тенант выводится из `tasks`.
Соблазн — политика с подзапросом:

```sql
-- ТАК МЫ НЕ ДЕЛАЕМ
CREATE POLICY tenant_isolation ON task_labels
  FOR ALL TO app_user
  USING (EXISTS (
    SELECT 1 FROM tasks t
    WHERE t.id = task_labels.task_id
      AND t.organization_id = current_setting('app.organization_id')::uuid
  ));
```

Почему это отвергнуто — четыре независимых причины:

1. **Стоимость.** Предикат политики вычисляется для каждой строки-кандидата. На выборке меток
   двухсот задач это двести дополнительных обращений к `tasks` — и планировщик не может
   превратить их в один хеш-джойн, потому что предикат RLS применяется как фильтр, а не как часть
   исходного запроса. На доске канбана это разница между 3 мс и 300 мс.
2. **Каскад RLS.** Подзапрос к `tasks` сам подчиняется политикам `tasks`. Значит проверка одной
   строки `task_labels` тянет за собой проверку строки `tasks`; на трёхуровневой связи
   (`task_labels → tasks → projects`) — три уровня. При взаимных ссылках между таблицами это
   заканчивается ошибкой рекурсии в политике, которую невозможно продиагностировать по тексту
   запроса.
3. **Хрупкость.** Видимость дочерней таблицы становится функцией политики родителя. Любое
   изменение политики `tasks` молча меняет поведение `task_labels`, `comments`, `attachments` и
   всего остального, что на неё сослалось. CI-чек «предикат совпадает с каноническим» перестаёт
   работать: предикатов становится столько, сколько форм связей.
4. **Индексы.** Составной индекс `(organization_id, …)` перестаёт быть применимым: в самой таблице
   этой колонки нет, отсекать чужие данные первым столбцом нечем.

**Решение — денормализовать `organization_id` в дочернюю таблицу** (это уже зафиксировано в
модели данных как общий принцип) и закрыть риск рассинхронизации **составным внешним ключом**:

```sql
-- родителям нужен уникальный ключ (organization_id, id) — иначе составной FK не построить.
-- Это дополнительный индекс, но он же полезен как покрывающий.
ALTER TABLE tasks  ADD CONSTRAINT uq_tasks_org_id  UNIQUE (organization_id, id);
ALTER TABLE labels ADD CONSTRAINT uq_labels_org_id UNIQUE (organization_id, id);

CREATE TABLE task_labels (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL,
  task_id         uuid        NOT NULL,
  label_id        uuid        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fk_task_labels_organization
    FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT,

  -- ключевое: ребёнок ссылается на пару (organization_id, id), а не на id.
  -- Строка с task_id из чужой организации физически не вставляется.
  CONSTRAINT fk_task_labels_task
    FOREIGN KEY (organization_id, task_id)  REFERENCES tasks  (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_task_labels_label
    FOREIGN KEY (organization_id, label_id) REFERENCES labels (organization_id, id) ON DELETE CASCADE,

  CONSTRAINT uq_task_labels UNIQUE (task_id, label_id)
);

CREATE INDEX idx_task_labels_org_task  ON task_labels (organization_id, task_id);
CREATE INDEX idx_task_labels_org_label ON task_labels (organization_id, label_id);
```

Далее — обычный канонический шаблон (`ENABLE` + `FORCE` + `tenant_isolation` + `GRANT`).

**Почему составной FK здесь обязателен, а не «желателен».** Проверки ссылочной целостности в
PostgreSQL выполняются системными триггерами от имени владельца таблицы и **обходят RLS** —
это документированное поведение. Следствие: простой `FOREIGN KEY (task_id) REFERENCES tasks (id)`
успешно подтвердит существование задачи **другой организации**. То есть без составного ключа
приложение может создать метку своей организации, указывающую на чужую задачу: RLS не нарушена
(`organization_id` строки — свой), FK не нарушен (задача существует), а данные разъехались.
Побочно это ещё и оракул: по успеху/неуспеху вставки можно проверять существование чужих id.
Составной FK закрывает оба эффекта одной строкой DDL.

Триггер, автоматически проставляющий `organization_id` из родителя, мы **не** используем: он
стоит одного лишнего чтения на каждую вставку, прячет реальное значение от `INSERT ... RETURNING`
и всё равно не защищает от рассинхронизации при `UPDATE` родителя. Составной FK дешевле и строже.

### Представления и материализованные представления

- Любое `VIEW` над [T]-таблицей создаётся **только** с `security_invoker = true` (PostgreSQL 15+,
  у нас 16). По умолчанию представление исполняется с правами владельца, то есть под
  `app_migrator` — и, если у того есть `maintenance_access`-политика или таблица без `FORCE`,
  представление становится дырой в изоляции.

  ```sql
  CREATE VIEW v_active_tasks WITH (security_invoker = true) AS
    SELECT id, organization_id, project_id, title, due_at
    FROM   tasks
    WHERE  deleted_at IS NULL;
  ```

- **`MATERIALIZED VIEW` над [T]-таблицами запрещены.** На матвью нельзя включить RLS, а её
  содержимое формируется в момент `REFRESH` под владельцем — то есть материализуется срез,
  зависящий от того, какой контекст был выставлен при обновлении, и доступный всем без фильтрации.
  Это закрывает открытый вопрос №8 модели данных: `TimeRollupDaily` остаётся обычной таблицей
  с `organization_id` и политикой, а не превращается в `MATERIALIZED VIEW`.

---

## Выставление контекста из приложения

### Обёртка `withTenant` и предохранитель `guardedClient`

```ts
// infrastructure/persistence/prisma/tenant-context.ts
import { AsyncLocalStorage } from 'node:async_hooks';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';

export type TxClient = Prisma.TransactionClient;

export interface TenantContext {
  readonly organizationId: string;
  readonly userId: string | null;
}

interface TenantStore {
  readonly ctx: TenantContext;
  readonly tx: TxClient;
}

const tenantStorage = new AsyncLocalStorage<TenantStore>();
const uuid = z.string().uuid();

export class MissingTenantContextError extends Error {
  constructor(where: string) {
    super(`Tenant context is missing for ${where}. Оберните вызов в withTenant().`);
    this.name = 'MissingTenantContextError';
  }
}

export class CrossTenantNestingError extends Error {
  constructor(outer: string, inner: string) {
    super(`Вложенный withTenant с другой организацией: ${outer} → ${inner}`);
    this.name = 'CrossTenantNestingError';
  }
}

export function currentTenant(): TenantStore | undefined {
  return tenantStorage.getStore();
}

/** Для сырого SQL: убеждаемся, что контекст есть, и отдаём транзакцию. */
export function requireTenant(where: string): TenantStore {
  const store = tenantStorage.getStore();
  if (!store) throw new MissingTenantContextError(where);
  return store;
}
```

```ts
export interface WithTenantOptions {
  readonly maxWaitMs?: number;
  readonly timeoutMs?: number;
  readonly isolationLevel?: Prisma.TransactionIsolationLevel;
}

/**
 * Открывает интерактивную транзакцию, фиксирует в ней tenant-контекст и кладёт
 * транзакционный клиент в AsyncLocalStorage. Вне этой обёртки [T]-таблицы недоступны.
 */
export async function withTenant<T>(
  base: PrismaClient,
  ctx: TenantContext,
  fn: (tx: TxClient) => Promise<T>,
  options: WithTenantOptions = {},
): Promise<T> {
  // Валидация до похода в БД: организация приходит из JWT/очереди, это внешний вход.
  const organizationId = uuid.parse(ctx.organizationId);
  const userId = ctx.userId === null ? null : uuid.parse(ctx.userId);

  const outer = tenantStorage.getStore();
  if (outer) {
    // Вложенных транзакций не открываем: переиспользуем внешнюю…
    if (outer.ctx.organizationId !== organizationId) {
      // …но смена тенанта внутри уже открытой транзакции — всегда баг.
      throw new CrossTenantNestingError(outer.ctx.organizationId, organizationId);
    }
    return fn(outer.tx);
  }

  return base.$transaction(
    async (tx) => {
      // set_config(..., is_local => true) — параметризуемый аналог SET LOCAL.
      // Тегированный шаблон превращает значение в bind-параметр $1: строковая
      // интерполяция здесь была бы инъекцией (см. ниже).
      await tx.$executeRaw`SELECT set_config('app.organization_id', ${organizationId}, true)`;
      await tx.$executeRaw`SELECT set_config('app.user_id',         ${userId ?? ''},   true)`;

      return tenantStorage.run({ ctx: { organizationId, userId }, tx }, () => fn(tx));
    },
    {
      maxWait: options.maxWaitMs ?? 2_000,
      timeout: options.timeoutMs ?? 5_000,
      isolationLevel: options.isolationLevel ?? Prisma.TransactionIsolationLevel.ReadCommitted,
    },
  );
}
```

```ts
/** Модели без tenancy: обращение к ним вне withTenant — законно. */
const GLOBAL_MODELS: ReadonlySet<string> = new Set<Prisma.ModelName>(['Permission', 'Activity']);

/**
 * Предохранитель: любая операция Prisma по [T]-модели вне tenant-контекста
 * не уходит в БД, а падает с понятной ошибкой.
 */
export function guardedClient(base: PrismaClient): PrismaClient {
  return base.$extends({
    name: 'tenant-guard',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (model !== undefined && GLOBAL_MODELS.has(model)) return query(args);
          if (tenantStorage.getStore() === undefined) {
            throw new MissingTenantContextError(`${model ?? 'unknown'}.${operation}`);
          }
          return query(args);
        },
      },
    },
  }) as unknown as PrismaClient;
}

/** Явный, логируемый выход из tenant-скоупа. Использовать только для [G]-таблиц. */
export async function withoutTenant<T>(reason: string, fn: () => Promise<T>): Promise<T> {
  logger.info({ reason, event: 'tenant.scope.bypass' }, 'запрос вне tenant-контекста');
  return tenantStorage.exit(fn);
}
```

Регистрация в composition root:

```ts
// main.ts (фрагмент)
const basePrisma = new PrismaClient({ datasourceUrl: env.DATABASE_URL });
await assertRuntimeDbRole(basePrisma);
const prisma = guardedClient(basePrisma);   // наружу отдаётся только защищённый клиент
```

Важно: `guardedClient` перехватывает операции **моделей**. Сырые `$queryRaw`/`$executeRaw` мимо
него проходят — именно поэтому сырой SQL обязан идти через хелпер, который сам требует контекст:

```ts
// infrastructure/persistence/prisma/raw.ts
export async function rawInTenant<T>(
  where: string,
  fn: (tx: TxClient, organizationId: string) => Promise<T>,
): Promise<T> {
  const { tx, ctx } = requireTenant(where);
  return fn(tx, ctx.organizationId);
}
```

и что `$queryRawUnsafe`/`$executeRawUnsafe` запрещены ESLint-правилом целиком (см. следующий
раздел).

### База репозитория: `TenantScopedRepository`

Реализация — `infrastructure/persistence/prisma/tenant-scoped.repository.ts` (STORY-005-03). Каждый
Prisma-репозиторий наследует её и ходит в БД **только** через `run(operation, work)`. Это снимает с
автора репозитория два решения, каждое из которых при ошибке не проявляется функционально.

**Какую транзакцию использовать.** Не аргумент конструктора и не параметр метода — та, что открыл
`withTenant`, взятая из `AsyncLocalStorage` в момент вызова. Репозиторий, принимающий транзакцию,
может получить её из чужого скоупа; репозиторий, принимающий `organizationId`, заводит **вторую
точку правды** о тенанте — и при расхождении запрос не отвергается, а *фильтруется*: политика
сравнивает строки с `app.organization_id`, поэтому наружу выходит пустой список, который читается
как «данных нет» (см. «Ловушки», 3).

```ts
export class PrismaOrganizationRepository extends TenantScopedRepository
  implements OrganizationRepositoryPort {
  protected readonly resource = 'organization' as const;
  protected readonly repositoryName = 'OrganizationRepository';

  create(draft: OrganizationDraft): Promise<OrganizationSummary> {
    return this.run('create', async (tx) => {
      // id берётся из скоупа: другого значения политика организаций и не пропустит
      const row = await tx.organization.create({ data: { id: this.organizationId('create'), ...draft } });
      return toOrganizationSummary(row);
    });
  }
}
```

**Открыт ли tenant-скоуп вообще.** `guardedClient` ловит вызов модели вне скоупа, но только для тех
вызовов, что идут через защищённый клиент; репозиторий держит транзакционный хендл и по построению
проходит мимо. `run` первым делом спрашивает `requireTenant`, поэтому отказ происходит и здесь —
до отправки запроса и с именем репозитория и операции вместо кода `42704`.

**Трансляция ошибок едет следом**, потому что это не то, что подкласс имеет право забыть:

| Prisma | Наружу | Почему |
|---|---|---|
| `P2002` (unique) | `<resource>_already_exists` (409) | для корня тенанта это глобально уникальный `slug`, и уникальный индекс — **единственный** наблюдатель коллизии: `SELECT … WHERE slug = $1` под политикой ещё не существующей организации всегда пуст |
| `P2025` (record not found) | `denyAccess(resource, 'other_organization')` → 404 | под RLS «нет строки» и «строка чужой организации» неразличимы — и обязаны такими остаться (инвариант 2) |
| всё остальное, включая нарушение RLS | без изменений → 500 | `new row violates row-level security policy` означает дефект приложения; аккуратный 409 на его месте спрятал бы его от лога |

Транзакцией управляет `UnitOfWorkPort` (`application/platform/ports/unit-of-work.port.ts`) — в этой
системе «транзакция» и «тенант» это одно и то же, поэтому метода `withTransaction` без тенанта в
порту не существует. Его реализация `PrismaUnitOfWork` строится на **базовом** клиенте (единственное
место, которому разрешено открывать транзакцию) и вызывает переданную функцию **без аргументов**,
чтобы `TxClient` не утёк в `application`.

### Проверка роли при старте: `assertRuntimeDbRole`

Реализация — `infrastructure/persistence/prisma/assert-db-role.util.ts`, вызов —
`infrastructure/bootstrap/api-process.factory.ts`, **до** `listen` и до старта воркеров
(STORY-005-05). Отказ — единственный сигнал, который получает оператор раньше, чем утечка:
подключение суперпользователем, владельцем схемы или любой ролью с `BYPASSRLS` обслуживает все
запросы корректно и не фильтрует ничего.

Одним запросом к каталогу собираются пять фактов, и любой из них валит старт:

| Факт | Почему это отказ |
|---|---|
| `current_user <> app_user` | остальные роли — обслуживание, не рантайм |
| `rolsuper` | политики к суперпользователю не применяются |
| `rolbypassrls` | политики не применяются |
| владелец схемы `public` | таблица, приехавшая без `FORCE`, для него не отфильтрована |
| `pg_has_role(current_user, 'app_migrator', 'MEMBER')` | изоляция держится ровно до одного `SET ROLE` |

Две детали важны построчно: `MEMBER`, а не `USAGE` (для `NOINHERIT`-роли `USAGE` отвечает `false`
там, где `SET ROLE` всё ещё возможен), и `to_regrole('app_migrator')` вместо приведения типа — на
кластере без bootstrap приведение бросило бы `42704`, и процесс умер бы с сообщением «роль не
существует» вместо ответа на заданный вопрос. Отсутствие строки в ответе — тоже отказ: «фактов нет»
не должно читаться как «проблем нет».

### Ловушки

**1. `SET` вместо `SET LOCAL` — худший из возможных багов.**

```sql
SET       app.organization_id = '…';   -- живёт до конца СОЕДИНЕНИЯ
SET LOCAL app.organization_id = '…';   -- живёт до конца ТРАНЗАКЦИИ
SELECT set_config('app.organization_id', $1, true);   -- то же, что SET LOCAL, но с параметром
```

Соединение возвращается в пул и достаётся следующему запросу — уже другого тенанта, — унося с
собой чужой `organization_id`. Проявляется только под конкурентной нагрузкой, не воспроизводится в
тестах, выглядит как «иногда пользователь видит чужие данные». Правило: в кодовой базе не должно
существовать ни одного `SET` без `LOCAL`; grep `\bSET\s+app\.` в CI ищет нарушения, а сам
`set_config` вызывается только внутри `withTenant`.

**2. `SET LOCAL` нельзя параметризовать — и поэтому его нельзя использовать напрямую.**
`SET` — утилитная команда, bind-параметры в ней не поддерживаются. Единственный способ подставить
значение — конкатенация строк, то есть инъекция при малейшей ошибке валидации. `set_config()` —
обычная функция, её аргументы параметризуются нормально. Это, а не вкусовщина, причина, по которой
в `withTenant` стоит `set_config`, а не `SET LOCAL`.

**3. Отсутствие контекста должно быть отказом, а не «показать всё».** Разберём три состояния
соединения:

| Состояние | Что вернёт `current_setting('app.organization_id')` | Что делает политика |
|---|---|---|
| параметр никогда не устанавливался в сессии | ошибка `42704 unrecognized configuration parameter` | запрос падает |
| устанавливался ранее через `SET LOCAL`, транзакция закрыта | пустая строка `''` | `''::uuid` → ошибка `22P02 invalid input syntax for type uuid` |
| установлен корректно | uuid | нормальная фильтрация |

Оба «плохих» состояния дают **ошибку**, а не пустую выборку — это ровно то, что нужно. Именно
поэтому в политике стоит `current_setting('app.organization_id')`, а **не**
`current_setting('app.organization_id', true)`: «мягкая» форма вернула бы `NULL`, сравнение
`organization_id = NULL` дало бы `NULL`, строка не прошла бы — и `SELECT` вернул бы пустой список
молча. Пустой список выглядит как «данных нет»: код создаст дубликат, отчёт покажет нули,
разработчик потратит день. `WITH CHECK` при `NULL` тоже не пропустит запись, так что утечки нет
ни в одном варианте, — но диагностируемость различается радикально.

Если хочется вместо `22P02` получать осмысленное сообщение, канонический предикат заменяется
эквивалентной обёрткой (одинаково на всех таблицах разом, иначе CI-чек не сойдётся):

```sql
CREATE FUNCTION app_current_org() RETURNS uuid
  LANGUAGE plpgsql
  STABLE                       -- вычисляется один раз на запрос, годится как ключ индексного поиска
  PARALLEL SAFE
  SET search_path = pg_catalog
AS $$
DECLARE v text := current_setting('app.organization_id', true);
BEGIN
  IF v IS NULL OR v = '' THEN
    RAISE EXCEPTION 'app.organization_id не выставлен: запрос вне tenant-контекста'
      USING ERRCODE = 'insufficient_privilege';   -- 42501, как и нарушение RLS
  END IF;
  RETURN v::uuid;
END $$;

REVOKE ALL ON FUNCTION app_current_org() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_current_org() TO app_user;

-- предикат политики принимает вид:
--   USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org())
```

Функция помечена `STABLE` и не имеет аргументов, поэтому вычисляется один раз на выполнение
запроса и остаётся пригодной как константа для индексного поиска — на планы это не влияет.

**4. Connection pooling и PgBouncer.**

- Интерактивная транзакция Prisma **пинит** соединение на всё время колбэка: пока внутри идут
  вызовы, соединение из пула никому не достанется. Это плата за корректный `SET LOCAL`. Отсюда два
  следствия: транзакция должна быть **одна на сценарий** (а не на каждый запрос), и внутри неё
  **никогда** не должно быть внешних HTTP-вызовов (S3, SMTP, AI, GitHub) — иначе секунда сетевого
  таймаута держит соединение и блокировки.
- PgBouncer допустим **только** в режиме `transaction` или `session`. В `statement`-режиме границ
  транзакции нет, `SET LOCAL` теряет смысл, а многооператорная транзакция вообще невозможна —
  изоляция ломается полностью и тихо.
- В `transaction`-режиме соединение отдаётся обратно на `COMMIT`, значит `SET LOCAL` не переживает
  границу транзакции — что нам и нужно. Обычный `SET` в этом режиме, наоборот, утечёт на чужой
  запрос: ещё одна причина запрета из ловушки №1.
- Prisma использует именованные prepared statements, которые в `transaction`-режиме PgBouncer не
  переживают смену серверного соединения. Поэтому в строке подключения через пулер обязателен
  `?pgbouncer=true` (отключает кеш prepared statements) — без него в логах появляются
  `prepared statement "s0" already exists`, причём под нагрузкой и не сразу.

  ```dotenv
  DATABASE_URL="postgresql://app_user:***@pgbouncer:6432/bad_crm?pgbouncer=true&connection_limit=1"
  ```

  `connection_limit=1` на инстанс приложения при внешнем пулере — осознанный выбор: пул держит
  PgBouncer, а не Prisma, иначе получается пул над пулом с непредсказуемым суммарным числом
  соединений.
- Для профилей `minimal`/`default` PgBouncer **не нужен**: собственного пула Prisma хватает,
  а лишний слой добавляет ровно эти грабли. Он появляется в `scaled`, когда реплик приложения
  становится больше, чем позволяет `max_connections`.
- `ALTER ROLE app_user SET statement_timeout` в режиме `transaction` применяется при создании
  серверного соединения (оно создаётся как `app_user`) — лимиты работают.

**5. `$transaction([...])` в массивной форме.** Она тоже открывает транзакцию, но контекст в ней
выставить нечем: элементы массива формируются заранее, гарантии, что `set_config` окажется первым
и в той же транзакции, у нас нет, а `guardedClient` этого не увидит. В проекте разрешена **только**
интерактивная форма через `withTenant`.

---

## Автоматизация: как невозможно забыть

Четыре независимых механизма. Каждый ловит свой класс ошибок; ни один не заменяет остальные.

### (а) ESLint: нет прямых `prisma.*` вне `infrastructure/persistence`

```js
// eslint.config.js (фрагмент, ESLint 9 flat config)
export default [
  // …
  {
    files: ['packages/server/src/**/*.ts'],
    ignores: ['packages/server/src/infrastructure/persistence/**'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [{
          name: '@prisma/client',
          message: 'Prisma доступна только в infrastructure/persistence. Наружу — порты и доменные сущности.',
        }],
        patterns: [{
          group: ['**/infrastructure/persistence/**'],
          message: 'Импортируйте порт из application/*/ports, а не реализацию репозитория.',
        }],
      }],
      'no-restricted-syntax': ['error',
        {
          selector: "MemberExpression[object.name='prisma']",
          message: 'Прямой вызов prisma.* запрещён вне infrastructure/persistence: запрос уйдёт мимо tenant-контекста.',
        },
        {
          selector: "MemberExpression[object.name='tx']",
          message: 'Транзакционный клиент не покидает persistence-слой.',
        },
      ],
    },
  },
  {
    // Внутри persistence Prisma можно, но небезопасный сырой SQL — нигде.
    files: ['packages/server/src/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error',
        {
          selector: "CallExpression[callee.property.name=/^\\$(queryRaw|executeRaw)Unsafe$/]",
          message: '$queryRawUnsafe/$executeRawUnsafe запрещены: используйте тегированный шаблон $queryRaw.',
        },
        {
          selector: "CallExpression[callee.property.name='$transaction'][arguments.0.type='ArrayExpression']",
          message: 'Массивная форма $transaction не выставляет tenant-контекст. Используйте withTenant().',
        },
      ],
    },
  },
];
```

Плюс два grep-чека в CI, которые дешевле кастомного правила и ловят то, что AST не видит:

```bash
# ни одного SET без LOCAL для наших GUC
! grep -rInE "\bSET\s+app\.(organization_id|user_id)\b" packages/server/src packages/server/prisma \
  || { echo "Найден SET без LOCAL"; exit 1; }

# ни одного set_config с is_local = false.
# Ровно одно исключение — глушение `log_statement` в bootstrap-скрипте ролей на время
# `ALTER ROLE … PASSWORD`: здесь нужен именно сессионный (is_local=false) вызов, локальная
# установка откатилась бы на выходе из блока, то есть до самой команды с паролем.
#
# Исключение сужено до одной строки, а не до файла. `--exclude=00-bootstrap-roles.sql` выключал
# проверку на весь файл: будущий `set_config('app.organization_id', …, false)`, добавленный туда,
# прошёл бы мимо чека — а это ровно та ошибка, ради которой чек существует.
if grep -rInE "set_config\([^)]*,\s*false\s*\)" packages/server/src packages/server/prisma \
   | grep -vF "set_config('log_statement', 'none', false)" | grep -q .; then
  echo "set_config с is_local=false"; exit 1
fi

# и позитивная проверка на само исключение: вхождение ровно одно и оно действительно про
# log_statement. Иначе «ничего не найдено» одинаково означает и «всё правильно», и «строку
# переименовали, а фильтр выше молча перестал что-либо разрешать или, наоборот, разрешил лишнее».
[ "$(grep -cF "set_config('log_statement', 'none', false)" \
       packages/server/prisma/sql/00-bootstrap-roles.sql)" = "1" ] \
  || { echo "ожидалось ровно одно разрешённое set_config(..., false)"; exit 1; }
```

### (б) Миграционный чек: каталог БД против списка таблиц

Скрипт `packages/server/scripts/check-rls.ts` (`pnpm check:rls`) **подключается к уже существующей
базе** — он ничего не поднимает и ничего не мигрирует — и сверяет три источника: `pg_catalog`,
Prisma-схему и реестр `tenant-tables.constant.ts`. Расхождение — ненулевой код возврата (1 —
нарушения, 2 — проверку не удалось выполнить).

Строка подключения приходит аргументом (`pnpm check:rls -- postgresql://…`) или из `DATABASE_URL`.
Запросы читают только `pg_catalog`, который доступен любой роли, — проверено под `app_user` в
`test/integration/db/rls-catalog-check.test.ts`, так что оператору не нужны права владельца.

Тот же аудит на миграции этого чекаута гоняет интеграционный набор
(`test/integration/db/migrations.test.ts`, `pnpm test:integration`) — он поднимает контейнер сам.
Роли не пересекаются и одна другую не заменяет: набор судит **миграцию в репозитории**, скрипт —
**конкретный хост**, где миграция применена давно, поверх неё прошёл `pg_restore --no-privileges`
и контейнер поднять негде. Канонический шаблон при этом описан **один раз** —
`src/infrastructure/persistence/prisma/rls-catalog.constant.ts`, откуда его читают и тест, и скрипт;
`test/unit/persistence/rls-catalog-sources.test.ts` падает, если он появится где-то ещё.

Ниже — запросы, которые скрипт выполняет (1–3 и сверка реестров реализованы; 4–5 остаются
нормативом для миграций и разбираются агентом `tenancy-rls-auditor` и `test/infra/grants-sql.test.ts`).

**Запрос 1 — включённость RLS.** Любая таблица с колонкой `organization_id`, у которой нет
`ENABLE` или `FORCE`:

```sql
WITH tenant_tables AS (
  SELECT c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity
  FROM   pg_class     c
  JOIN   pg_namespace n ON n.oid = c.relnamespace
  WHERE  n.nspname   = 'public'
    AND  c.relkind   IN ('r', 'p')          -- обычные и партиционированные
    AND  NOT c.relispartition                -- партиции проверяются отдельным запросом
    AND  EXISTS (
           SELECT 1 FROM pg_attribute a
           WHERE  a.attrelid = c.oid
             AND  a.attname  = 'organization_id'
             AND  a.attnum   > 0
             AND  NOT a.attisdropped
         )
)
SELECT relname AS table_name,
       CASE
         WHEN NOT relrowsecurity      THEN 'RLS не включён (ENABLE ROW LEVEL SECURITY)'
         WHEN NOT relforcerowsecurity THEN 'RLS не форсирован (FORCE ROW LEVEL SECURITY)'
       END AS problem
FROM   tenant_tables
WHERE  NOT relrowsecurity OR NOT relforcerowsecurity
ORDER  BY relname;
```

**Запрос 2 — покрытие политиками по каждой команде.** Формулировка, которая переживает и
`FOR ALL`, и разбиение по командам: *если у `app_user` есть привилегия на команду — должна
существовать политика, покрывающая эту команду каноническим предикатом.*

```sql
WITH tenant_tables AS ( /* тот же CTE, что выше */ ),
canon AS (
  -- Каноническими считаются ровно две формы предиката; всё прочее — нарушение.
  SELECT '^\(?organization_id = \(?(current_setting\(''app\.organization_id''(::text)?\)\)?::uuid|app_current_org\(\))\)?$'::text AS re
),
cmds(cmd, priv, polcmd, needs_qual, needs_check) AS (
  VALUES ('SELECT', 'SELECT', 'r', true,  false),
         ('INSERT', 'INSERT', 'a', false, true ),
         ('UPDATE', 'UPDATE', 'w', true,  true ),
         ('DELETE', 'DELETE', 'd', true,  false)
)
SELECT t.relname AS table_name,
       k.cmd,
       'нет PERMISSIVE-политики для app_user с каноническим предикатом' AS problem
FROM       tenant_tables t
CROSS JOIN cmds  k
CROSS JOIN canon
WHERE has_table_privilege('app_user', t.oid, k.priv)
  AND NOT EXISTS (
        SELECT 1
        FROM   pg_policy p
        WHERE  p.polrelid     = t.oid
          AND  p.polpermissive
          AND (p.polroles = '{0}'::oid[]                       -- политика для PUBLIC
               OR p.polroles @> ARRAY['app_user'::regrole::oid])
          AND  p.polcmd IN ('*', k.polcmd)
          AND (NOT k.needs_qual
               OR pg_get_expr(p.polqual,      p.polrelid) ~ canon.re)
          AND (NOT k.needs_check
               OR pg_get_expr(p.polwithcheck, p.polrelid) ~ canon.re)
      )
ORDER BY t.relname, k.cmd;
```

**Запрос 3 — расширяющие политики.** PERMISSIVE-политика с неканоническим предикатом добавляет
доступ через OR. Проверяются **все** роли, а не только `app_user`: PERMISSIVE-политики
складываются дизъюнкцией **внутри своей роли**, поэтому
`PERMISSIVE FOR ALL TO app_migrator USING (true)` не меняет ничего для приложения и при этом
возвращает владельцу все организации разом — миграциям, ручному `psql`, скрипту обслуживания,
восстановлению. Ровно так выглядит `maintenance_access`, пересозданный при ручном ремонте без
предиката-переключателя. Допустимых предикатов на `[T]`-таблице два: канонический tenant-предикат
**по той колонке, которую объявляет реестр** (`organization_id`, либо `id` у корня тенанта), и
maintenance-переключатель. RESTRICTIVE-политики пропускаются — они соединяются по AND и способны
только сузить.

```sql
WITH tenant_tables AS ( /* … */ ), canon AS ( /* … */ )
SELECT t.relname AS table_name,
       p.polname AS policy_name,
       pg_get_expr(p.polqual, p.polrelid) AS using_expr,
       'PERMISSIVE-политика расширяет доступ (объединяется по OR)' AS problem
FROM       tenant_tables t
JOIN       pg_policy p ON p.polrelid = t.oid
CROSS JOIN canon
WHERE p.polpermissive
  AND (pg_get_expr(p.polqual, p.polrelid) IS NULL
       OR (pg_get_expr(p.polqual, p.polrelid) !~ canon.re
           AND pg_get_expr(p.polqual, p.polrelid) !~ canon.maintenance_re));
```

**Запрос 4 — гранты.** Ни у `PUBLIC`, ни у партиций не должно быть прав; `app_user` не должен
иметь `TRUNCATE`; на журнальных таблицах — ни `UPDATE`, ни `DELETE`:

```sql
-- 4a. PUBLIC не имеет ничего на доменных таблицах
SELECT c.relname, 'права выданы PUBLIC' AS problem
FROM   pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE  n.nspname = 'public' AND c.relkind IN ('r','p')
  AND  has_table_privilege('public', c.oid, 'SELECT,INSERT,UPDATE,DELETE');

-- 4b. app_user не имеет TRUNCATE нигде (TRUNCATE игнорирует RLS)
SELECT c.relname, 'app_user имеет TRUNCATE' AS problem
FROM   pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE  n.nspname = 'public' AND c.relkind IN ('r','p')
  AND  has_table_privilege('app_user', c.oid, 'TRUNCATE');

-- 4c. партиции недоступны напрямую
SELECT c.relname, 'у партиции есть права app_user' AS problem
FROM   pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE  n.nspname = 'public' AND c.relispartition
  AND  has_table_privilege('app_user', c.oid, 'SELECT,INSERT,UPDATE,DELETE');

-- 4d. журналы append-only
SELECT c.relname, 'журнальная таблица изменяема приложением' AS problem
FROM   pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE  n.nspname = 'public'
  AND  c.relname IN ('audit_logs','activity_events','vault_access_logs','secure_link_views')
  AND  has_table_privilege('app_user', c.oid, 'UPDATE,DELETE');

-- 4e. представления над доменными таблицами обязаны быть security_invoker
SELECT c.relname, 'VIEW без security_invoker = true' AS problem
FROM   pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE  n.nspname = 'public' AND c.relkind = 'v'
  AND  COALESCE((SELECT option_value FROM pg_options_to_table(c.reloptions)
                 WHERE option_name = 'security_invoker'), 'false') <> 'true';

-- 4f. материализованных представлений над доменными данными быть не должно
SELECT c.relname, 'MATERIALIZED VIEW не поддерживает RLS' AS problem
FROM   pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE  n.nspname = 'public' AND c.relkind = 'm';

-- 4g. каждая таблица читается бэкапом. BYPASSRLS снимает политики, но не гранты, а
--     ALTER DEFAULT PRIVILEGES запрещён — значит забытый GRANT роняет pg_dump на LOCK TABLE.
--     Это единственная машинная защита от «бэкап отстаёт от схемы на каждую новую таблицу».
--
--     has_table_privilege с несуществующей ролью не возвращает false, а падает
--     (`ERROR: role "backup_role" does not exist`) и уносит с собой весь чек — поэтому
--     EXISTS-гард: отсутствие роли должно диагностироваться, а не выглядеть сбоем запроса.
SELECT c.relname, 'нет GRANT SELECT для backup_role — таблица выпадет из бэкапа' AS problem
FROM   pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE  EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backup_role')
  AND  n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relispartition
  AND  NOT has_table_privilege('backup_role', c.oid, 'SELECT');

-- 4g-2. …и то же самое для листов партиций, отдельной веткой. pg_dump выгружает
--       партиционированную таблицу полистно и проверяет права на листе; грант родителя на лист не
--       распространяется. Без этой ветки `audit_logs` проходит 4g зелёным и роняет бэкап.
SELECT c.relname, 'нет GRANT SELECT для backup_role на партиции — упадёт весь дамп' AS problem
FROM   pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE  EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backup_role')
  AND  n.nspname = 'public'
  AND  c.relispartition
  AND  NOT has_table_privilege('backup_role', c.oid, 'SELECT');

-- 4g-3. последовательности. pg_dump читает last_value из каждой и останавливается на первой,
--       которую не может прочитать: `permission denied for sequence audit_logs_id_seq`.
SELECT c.relname, 'нет GRANT SELECT для backup_role на sequence' AS problem
FROM   pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE  EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backup_role')
  AND  n.nspname = 'public' AND c.relkind = 'S'
  AND  NOT has_sequence_privilege('backup_role', c.oid, 'SELECT');

-- 4h. роль бэкапа вообще существует. Без этого три проверки выше молча ничего не возвращают:
--     EXISTS-гард делает их пустыми, и «нет находок» читается как «всё в порядке».
SELECT 'backup_role' AS relname, 'роль backup_role не существует — бэкап снимать нечем' AS problem
WHERE  NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backup_role');
```

Все эти гранты не пишутся руками в каждой миграции и не переживают восстановление из дампа
(`--no-privileges` на обеих сторонах цикла стирает их полностью). Их источник истины —
`packages/server/prisma/sql/01-grants.sql`: идемпотентный обход каталога, который раздаёт права по
правилам выше и запускается **после каждой миграции** и **после каждого `pg_restore`**
(`pnpm db:grants`, [`../runbooks/backup-restore.md`](../runbooks/backup-restore.md)). Проверки 4a–4h
остаются независимой сверкой результата: файл, который сам себя проверяет, ничего не гарантирует.

**Запрос 5 — роли.** Дублирует стартовую проверку, но выполняется в CI. Ловит и обратную ошибку:
роль бэкапа без `BYPASSRLS` снимает частичный дамп молча, а роль бэкапа с правом записи — уже не
роль бэкапа:

```sql
SELECT rolname, 'роль приложения обходит RLS' AS problem
FROM   pg_roles
WHERE  rolname = 'app_user' AND (rolsuper OR rolbypassrls);

SELECT rolname, 'backup_role без BYPASSRLS — дамп будет частичным' AS problem
FROM   pg_roles
WHERE  rolname = 'backup_role' AND NOT rolbypassrls;

SELECT 'backup_role' AS rolname, 'backup_role имеет права на запись' AS problem
WHERE  EXISTS (
  SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE  n.nspname = 'public' AND c.relkind IN ('r','p')
    AND  has_table_privilege('backup_role', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE'));

-- Ни одна из четырёх ролей не может «стать» другой. Режим MEMBER, а не USAGE: при NOINHERIT
-- USAGE вернёт false для роли, которая фактически может выполнить SET ROLE.
SELECT m.rolname, 'может SET ROLE в ' || g.rolname AS problem
FROM   pg_roles m CROSS JOIN pg_roles g
WHERE  m.rolname <> g.rolname
  AND  m.rolname IN ('app_user','app_migrator','app_auth','backup_role')
  AND  g.rolname IN ('app_user','app_migrator','app_auth','backup_role')
  AND  pg_has_role(m.rolname, g.oid, 'MEMBER');
```

Как это устроено в коде (три файла, ни один не дублирует другой):

| Файл | Что в нём |
|---|---|
| `src/infrastructure/persistence/prisma/rls-catalog.constant.ts` | канонический предикат и три запроса к каталогу — **единственное** определение шаблона |
| `src/infrastructure/persistence/prisma/rls-catalog.util.ts` | `readRlsCatalog` (запросы → факты) и `rlsCatalogViolations` (факты → находки) — чистая функция, у неё есть положительный контроль в `pnpm test`, без Docker |
| `src/infrastructure/persistence/prisma/rls-report.util.ts` | человекочитаемый отчёт: что проверено, что не так, что делать |
| `scripts/check-rls.ts` | подключение (аргумент или `DATABASE_URL`), печать отчёта, код возврата |

```ts
// packages/server/scripts/check-rls.ts — по сути весь скрипт
const pool = new Pool({ connectionString, max: 1 });

const facts = await readRlsCatalog(async (sql) => (await pool.query(sql)).rows);
const findings = rlsCatalogViolations(facts);          // реестр и Prisma-схема — значения по умолчанию

process.stdout.write(`${renderRlsReport(findings, { … })}\n`);
process.exitCode = findings.length === 0 ? 0 : 1;      // 2 — если проверку не удалось выполнить
```

Почему не `PrismaClient` и не `$queryRawUnsafe`, как выглядел первоначальный набросок: `pg` не
требует сгенерированного клиента для соединения, а `$queryRawUnsafe` запрещён линтером на сервере —
скрипту это правило формально не адресовано, но заводить в репозитории второй стиль обращения к БД
ради одного инструмента не за что.

Сверка реестров идёт в обе стороны и включает Prisma-схему: «таблица с `organization_id` есть в БД,
но не в реестре» (её никто не покрывает isolation-тестом), «реестр есть, таблицы нет» (протухшее
ожидание держит зелёными тесты удалённой таблицы) и «таблица есть в БД, но ни одна Prisma-модель её
не несёт» (база разъехалась со схемой — ровно то, что остаётся после ручного ремонта на staging).

Prisma собственным drift-detection политики не видит: `migrate diff` сравнивает схему, а не каталог
RLS. Поэтому в CI на каждый PR аудит гоняет интеграционный набор (job `database isolation`), а на
живом хосте — этот скрипт: после деплоя миграций и обязательно после восстановления из бэкапа
([`../runbooks/backup-restore.md`](../runbooks/backup-restore.md), чек-лист 7.4).

### (в) Генератор isolation-тестов по списку [T]-таблиц

Реестр строится из DMMF, а не пишется руками — новая модель с `organizationId` попадает в набор
автоматически:

```ts
// infrastructure/persistence/prisma/tenant-tables.ts
import { Prisma } from '@prisma/client';

export interface TenantTable {
  readonly model: Prisma.ModelName;
  readonly table: string;
  /** Колонка тенанта: у organizations это собственный первичный ключ. */
  readonly tenantColumn: 'organization_id' | 'id';
}

export const TENANT_TABLES: readonly TenantTable[] = Prisma.dmmf.datamodel.models
  .filter((m) => m.name === 'Organization' || m.fields.some((f) => f.name === 'organizationId'))
  .map((m) => ({
    model: m.name as Prisma.ModelName,
    table: m.dbName ?? m.name,
    tenantColumn: m.name === 'Organization' ? 'id' : 'organization_id',
  }));

export type TenantTableName = (typeof TENANT_TABLES)[number]['table'];
```

Дальше — фабрики строк. Ключевой приём: реестр фабрик типизирован как исчерпывающая карта, поэтому
**новая [T]-таблица без фабрики — ошибка компиляции**, а не молча непокрытая таблица:

```ts
// test/integration/rls/row-factories.ts
export type RowFactory = (orgId: string, ctx: SeedContext) => Promise<{ id: string }>;

export const ROW_FACTORIES = {
  tasks:        async (orgId, c) => c.insert('tasks',        { organization_id: orgId, project_id: c.projectId(orgId), /* … */ }),
  task_labels:  async (orgId, c) => c.insert('task_labels',  { organization_id: orgId, task_id: c.taskId(orgId), label_id: c.labelId(orgId) }),
  // …по одной строке на таблицу
} satisfies Record<TenantTableName, RowFactory>;
```

Порядок создания зависимостей (`organizations → users → projects → tasks → …`) описывается один
раз в `SeedContext`; фабрика листовой таблицы просто просит у контекста нужный родительский id.

### (г) Проектный агент `tenancy-rls-auditor`

Живёт в `.claude/agents/tenancy-rls-auditor.md`, запускается в commit-гейте, когда дельта задевает
`prisma/schema.prisma`, `prisma/migrations/**`, `infrastructure/persistence/**` или
`docs/security/rls-design.md`.

```markdown
---
name: tenancy-rls-auditor
description: >
  Аудит мульти-тенантной изоляции. Проверяет, что каждая новая/изменённая таблица получила
  organization_id, ENABLE+FORCE RLS, политику с USING и WITH CHECK, гранты, индекс и
  isolation-тест; что доступ к БД идёт через withTenant; что не появилось обходов.
  Запускать при любом изменении схемы, миграций или persistence-слоя.
tools: Read, Grep, Glob, Bash
---
```

Что он проверяет сверх скрипта (то, что регуляркой по каталогу не ловится):

1. Новая модель в `schema.prisma` имеет `organizationId` **и** миграция того же PR содержит
   `ENABLE`/`FORCE`/`CREATE POLICY`/`GRANT` для неё.
2. У связей на родителя используется составной FK `(organization_id, parent_id)`, а не одиночный.
3. В диффе нет `$queryRawUnsafe`, `SET app.`, `bypassRls`, `withoutTenant` без обоснования в
   описании PR.
4. Появившиеся `SECURITY DEFINER`-функции имеют `SET search_path`, `REVOKE ... FROM PUBLIC` и
   точечный `GRANT EXECUTE`; их тело не принимает динамический SQL.
5. Новые фоновые обработчики читают `organizationId` из конверта job'а и обёрнуты в `runJob`.
6. Для каждой новой [T]-таблицы есть фабрика строки в `ROW_FACTORIES`.

Вердикт — `PASS`/`FAIL` с перечнем находок и точными путями. `FAIL` блокирует коммит; исключение
возможно только явным решением пользователя с фиксацией в описании PR.

---

## Обязательные тесты изоляции

Мок ORM про политики Postgres ничего не знает, поэтому единственный осмысленный способ проверки —
реальный Postgres в Testcontainers. Набор гоняется в `pnpm test:integration` и в CI на каждый PR.

### Обвязка

```ts
// test/integration/rls/setup.ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { execa } from 'execa';

export interface RlsHarness {
  /** Пул под ролью app_user — под ней политики применяются. */
  readonly app: Pool;
  /** Пул под владельцем — только для подготовки данных в обход RLS. */
  readonly owner: Pool;
  readonly orgA: string;
  readonly orgB: string;
}

export async function startHarness(): Promise<RlsHarness & { stop(): Promise<void> }> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('pgvector/pgvector:pg16')
    .withDatabase('bad_crm')
    .withUsername('postgres')
    .withPassword('postgres')
    .start();

  const superUrl = container.getConnectionUri();
  await execa('psql', [superUrl, '-v', 'ON_ERROR_STOP=1',
    '-v', 'migrator_pw=m', '-v', 'app_pw=a', '-v', 'auth_pw=t',
    '-f', 'prisma/sql/00-bootstrap-roles.sql']);
  await execa('pnpm', ['prisma', 'migrate', 'deploy'], {
    env: { DATABASE_MIGRATION_URL: urlAs(superUrl, 'app_migrator', 'm') },
  });

  const owner = new Pool({ connectionString: urlAs(superUrl, 'app_migrator', 'm') });
  const app   = new Pool({ connectionString: urlAs(superUrl, 'app_user',     'a') });
  // … создание двух организаций через owner в режиме app.maintenance = 'on'
  return { app, owner, orgA, orgB, stop: async () => { await app.end(); await owner.end(); await container.stop(); } };
}

/** Выполняет запрос под tenant-контекстом ровно так, как это делает приложение. */
export async function asTenant<T>(pool: Pool, orgId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.organization_id', orgId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
```

Тесты обращаются к Postgres напрямую через `pg`, а не через Prisma. Это сознательно: проверяется
**база**, а не обёртка. Если бы тесты ходили через `withTenant`, корректно работающая обёртка
маскировала бы отсутствующую политику — а нам нужно ровно обратное.

### Параметризованный шаблон

```ts
// test/integration/rls/rls-isolation.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { TENANT_TABLES } from '@/infrastructure/persistence/prisma/tenant-tables';
import { ROW_FACTORIES } from './row-factories';
import { startHarness, asTenant } from './setup';

let h: Awaited<ReturnType<typeof startHarness>>;
beforeAll(async () => { h = await startHarness(); }, 120_000);
afterAll(async () => { await h.stop(); });

describe.each(TENANT_TABLES)('RLS · $table', ({ table, tenantColumn }) => {
  let idA: string;
  let idB: string;

  beforeEach(async () => {
    idA = (await ROW_FACTORIES[table](h.orgA, seedCtx)).id;
    idB = (await ROW_FACTORIES[table](h.orgB, seedCtx)).id;
  });

  // КОНТРОЛЬ. Без него весь остальной файл проходит вхолостую: если соединение
  // окажется под ролью без политики (или под владельцем с FORCE), все негативные
  // проверки станут истинными просто потому, что не видно вообще ничего.
  it('своя строка видна (контроль)', async () => {
    const rows = await asTenant(h.app, h.orgA, (c) =>
      c.query(`SELECT id FROM ${table} WHERE id = $1`, [idA]).then((r) => r.rows));
    expect(rows).toHaveLength(1);
  });

  it('SELECT: чужая строка не видна', async () => {
    const rows = await asTenant(h.app, h.orgA, (c) =>
      c.query(`SELECT id FROM ${table} WHERE id = $1`, [idB]).then((r) => r.rows));
    expect(rows).toHaveLength(0);
  });

  it('COUNT/агрегат не учитывает чужие строки', async () => {
    const { count } = await asTenant(h.app, h.orgA, (c) =>
      c.query(`SELECT count(*)::int AS count FROM ${table}`).then((r) => r.rows[0]));
    const total = await h.owner.query(`SELECT count(*)::int AS count FROM ${table}`);
    expect(count).toBeGreaterThan(0);                       // контроль: что-то видно
    expect(count).toBeLessThan(total.rows[0].count);        // но не всё
  });

  it('INSERT с чужим organization_id отклонён (WITH CHECK)', async () => {
    await expect(
      asTenant(h.app, h.orgA, async (c) => {
        const row = await ROW_FACTORIES[table](h.orgB, seedCtx.viaClient(c));
        return row;
      }),
    ).rejects.toMatchObject({ code: '42501' });   // new row violates row-level security policy
  });

  it('UPDATE чужой строки затрагивает 0 строк', async () => {
    const res = await asTenant(h.app, h.orgA, (c) =>
      c.query(`UPDATE ${table} SET updated_at = now() WHERE id = $1`, [idB]));
    expect(res.rowCount).toBe(0);
  });

  it('нельзя переложить свою строку в чужой тенант', async () => {
    if (tenantColumn !== 'organization_id') return;         // organizations проверяется отдельно
    await expect(
      asTenant(h.app, h.orgA, (c) =>
        c.query(`UPDATE ${table} SET organization_id = $1 WHERE id = $2`, [h.orgB, idA])),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('DELETE чужой строки затрагивает 0 строк', async () => {
    const res = await asTenant(h.app, h.orgA, (c) =>
      c.query(`DELETE FROM ${table} WHERE id = $1`, [idB]));
    expect(res.rowCount).toBe(0);
  });

  it('JOIN не протаскивает чужие строки', async () => {
    if (tenantColumn !== 'organization_id') return;
    const rows = await asTenant(h.app, h.orgA, (c) =>
      c.query(
        `SELECT t.id FROM ${table} t
         JOIN organizations o ON o.id = t.organization_id
         WHERE t.id = ANY($1::uuid[])`, [[idA, idB]]).then((r) => r.rows));
    expect(rows.map((r) => r.id)).toEqual([idA]);
  });

  it('без tenant-контекста запрос падает, а не отдаёт всё', async () => {
    const client = await h.app.connect();
    try {
      await client.query('BEGIN');
      await expect(client.query(`SELECT id FROM ${table} LIMIT 1`))
        // 42704 — параметр в сессии не определён; 22P02 — определён и пуст (соединение из пула).
        .rejects.toMatchObject({ code: expect.stringMatching(/^(42704|22P02)$/) });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});
```

Дополнительно, вне `describe.each` — три сквозных теста, которые проверяют механизм, а не таблицу:

```ts
it('guardedClient не пускает запрос вне withTenant', async () => {
  await expect(prisma.task.findMany()).rejects.toThrow(MissingTenantContextError);
});

it('withTenant не позволяет сменить тенанта внутри открытой транзакции', async () => {
  await expect(
    withTenant(prisma, { organizationId: orgA, userId: null }, () =>
      withTenant(prisma, { organizationId: orgB, userId: null }, async () => undefined)),
  ).rejects.toThrow(CrossTenantNestingError);
});

it('контекст не переживает транзакцию (нет утечки через пул)', async () => {
  await withTenant(prisma, { organizationId: orgA, userId: null }, async (tx) => {
    await tx.$queryRaw`SELECT 1`;
  });
  // то же физическое соединение, новая транзакция без контекста
  await expect(basePrisma.$queryRaw`SELECT count(*) FROM tasks`).rejects.toMatchObject({
    // Prisma заворачивает ошибку, проверяем по тексту SQLSTATE
    message: expect.stringMatching(/22P02|42704/),
  });
});
```

Контейнер поднимается один на файл (`globalSetup`), между тестами — `TRUNCATE … RESTART IDENTITY
CASCADE` под владельцем в режиме обслуживания, а не пересоздание контейнера.

---

## Особые пути

Три места, где обычный «контекст из JWT → `withTenant`» не работает. Каждое — потенциальная дыра,
поэтому каждое описано целиком.

### Путь 1. Логин: организация ещё не известна

Проблема курицы и яйца: чтобы прочитать `users`, нужен `app.organization_id`; чтобы его узнать,
нужно прочитать `users`.

**Основной способ — резолв организации до чтения пользователя.** Организация определяется из
поддомена (`acme.crm.example.com`) или из явного поля формы входа; `slug` уникален глобально, а
пара `(organization_id, email)` уникальна внутри тенанта. Тогда лукап идёт по паре и не является
оракулом «в каких организациях есть такой e-mail».

```sql
-- функции пути аутентификации принадлежат app_auth (единственная роль с BYPASSRLS)
SET ROLE app_auth;   -- выполняется миграцией под app_migrator, который членом app_auth не является;
                     -- на практике: CREATE FUNCTION ... ; ALTER FUNCTION ... OWNER TO app_auth;

CREATE OR REPLACE FUNCTION auth_lookup_user(p_email citext, p_org_slug text)
RETURNS TABLE (
  user_id             uuid,
  organization_id     uuid,
  password_hash       text,
  status              text,
  totp_secret_enc     text,
  permissions_version int
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public     -- обязательно: иначе SECURITY DEFINER — вектор подмены схемы
AS $$
  SELECT u.id, u.organization_id, u.password_hash, u.status::text,
         u.totp_secret_enc, u.permissions_version
  FROM   users u
  JOIN   organizations o ON o.id = u.organization_id
  WHERE  u.email      = p_email
    AND  o.slug       = p_org_slug
    AND  u.deleted_at IS NULL
    AND  o.deleted_at IS NULL
$$;

ALTER FUNCTION auth_lookup_user(citext, text) OWNER TO app_auth;
REVOKE ALL     ON FUNCTION auth_lookup_user(citext, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION auth_lookup_user(citext, text) TO   app_auth;
```

Что здесь важно построчно:

- **Возвращаются только поля, нужные для проверки пароля и второго фактора.** Не `SELECT *`:
  функция — привилегированная поверхность, и всё лишнее в её выхлопе рано или поздно окажется в
  логе или в ответе API.
- **`SET search_path = pg_catalog, public`** — без этого вызывающий может подсунуть свою схему с
  подменённой таблицей `users`, и функция выполнит её с правами владельца. Это классическая
  уязвимость `SECURITY DEFINER`, а не теоретическая.
- **`STABLE`, а не `VOLATILE`** — функция ничего не пишет; лишние побочные эффекты в
  привилегированном контексте не нужны.
- **`REVOKE ... FROM PUBLIC` до `GRANT`** — по умолчанию `EXECUTE` на функции выдан `PUBLIC`.
  Забытый `REVOKE` означает, что функцию может вызвать `app_user`, а значит — и SQL-инъекция под
  ним.

**Фолбэк-поиск по одному e-mail** нужен для инсталляций с единственной организацией и для входа
без поддомена. Он опаснее (это готовый оракул «существует ли такой e-mail в системе»), поэтому
обставлен ограничениями:

```sql
CREATE OR REPLACE FUNCTION auth_lookup_user_by_email(p_email citext)
RETURNS TABLE (
  user_id         uuid,
  organization_id uuid,
  organization_slug text,
  password_hash   text,
  status          text,
  match_count     int
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n
  FROM   users u JOIN organizations o ON o.id = u.organization_id
  WHERE  u.email = p_email AND u.deleted_at IS NULL AND o.deleted_at IS NULL;

  -- Больше одного совпадения — не отдаём НИЧЕГО, кроме счётчика.
  -- Иначе функция раскрывает список организаций, где зарегистрирован e-mail.
  IF n <> 1 THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::text, n;
    RETURN;
  END IF;

  RETURN QUERY
    SELECT u.id, u.organization_id, o.slug, u.password_hash, u.status::text, n
    FROM   users u JOIN organizations o ON o.id = u.organization_id
    WHERE  u.email = p_email AND u.deleted_at IS NULL AND o.deleted_at IS NULL;
END $$;

ALTER FUNCTION auth_lookup_user_by_email(citext) OWNER TO app_auth;
REVOKE ALL     ON FUNCTION auth_lookup_user_by_email(citext) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION auth_lookup_user_by_email(citext) TO   app_auth;
```

При `match_count > 1` API отвечает «уточните организацию» — и это единственная ситуация, в которой
он вообще что-то сообщает о множественности; при `match_count = 0` ответ неотличим от неверного
пароля.

**Третий org-less путь, о котором легко забыть, — refresh.** Обновление токена приходит с cookie
и без организации:

```sql
CREATE OR REPLACE FUNCTION auth_lookup_session(p_refresh_hash bytea)
RETURNS TABLE (session_id uuid, user_id uuid, organization_id uuid,
               family_id uuid, revoked_at timestamptz, expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT s.id, s.user_id, s.organization_id, s.family_id, s.revoked_at, s.expires_at
  FROM   sessions s
  WHERE  s.refresh_token_hash = p_refresh_hash
$$;

ALTER FUNCTION auth_lookup_session(bytea) OWNER TO app_auth;
REVOKE ALL     ON FUNCTION auth_lookup_session(bytea) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION auth_lookup_session(bytea) TO   app_auth;
```

Функция **только читает**: и ротация, и отзыв семейства при reuse detection выполняются уже под
`app_user` в `withTenant` — организация к этому моменту известна.

Прикладной код:

```ts
// infrastructure/persistence/prisma/auth-lookup.ts — единственный модуль, использующий app_auth
const authPrisma = new PrismaClient({ datasourceUrl: env.DATABASE_AUTH_URL });

interface AuthUserRow {
  user_id: string | null;
  organization_id: string | null;
  password_hash: string | null;
  status: string | null;
  match_count?: number;
}

export async function lookupUserForLogin(email: string, orgSlug: string | null): Promise<AuthUserRow | null> {
  const rows = orgSlug
    ? await authPrisma.$queryRaw<AuthUserRow[]>`SELECT * FROM auth_lookup_user(${email}::citext, ${orgSlug})`
    : await authPrisma.$queryRaw<AuthUserRow[]>`SELECT * FROM auth_lookup_user_by_email(${email}::citext)`;
  return rows[0] ?? null;
}
```

```ts
// application/identity/use-cases/login.use-case.ts (фрагмент)
const row = await this.authLookup.lookupUserForLogin(input.email, input.organizationSlug);

// Постоянное время ответа: при отсутствии пользователя всё равно считаем argon2 по фиктивному хешу,
// иначе разница в задержке превращает эндпоинт в перечислитель учёток.
const passwordOk = await this.hasher.verify(row?.password_hash ?? DUMMY_ARGON2_HASH, input.password);
if (!row?.user_id || !passwordOk || row.status !== 'ACTIVE') {
  throw new UnauthenticatedError('invalid_credentials');   // один и тот же код на все случаи
}

// Организация известна — дальше всё под app_user и под RLS.
return withTenant(this.prisma, { organizationId: row.organization_id!, userId: row.user_id }, async (tx) => {
  const session = await this.sessions.create(tx, /* … */);
  await this.audit.record(tx, { action: 'auth.login.succeeded', /* … */ });
  return this.tokens.issue(session);
});
```

Границы пути: соединение `app_auth` используется **только** этими тремя функциями; ни один
репозиторий, ни один use-case больше его не видит. Rate-limit на логин (5 попыток / 15 мин по паре
IP+email) обязателен — BYPASSRLS-поверхность не должна быть дёшево перебираемой.

### Путь 2. Анонимная защищённая ссылка

Получатель не аутентифицирован и не принадлежит организации, но должен прочитать ровно одну строку
`secure_links` и связанный с ней ресурс.

```sql
CREATE OR REPLACE FUNCTION secure_link_resolve(
  p_token_hash bytea,
  p_ip_hash    text,
  p_user_agent text
)
RETURNS TABLE (
  link_id         uuid,
  organization_id uuid,
  kind            text,
  payload_enc     bytea,
  resource_type   text,
  resource_id     uuid,
  requires_auth   boolean,
  password_hash   text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  r secure_links%ROWTYPE;
BEGIN
  -- Блокировка строки сериализует параллельные переходы по одной ссылке.
  -- Без FOR UPDATE два одновременных клика по ONE_TIME-ссылке проходят оба.
  SELECT * INTO r
  FROM   secure_links
  WHERE  token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    -- Несуществующий токен: журналировать нечего (нет организации), выходим молча.
    -- Перебор токенов сдерживается rate-limit'ом на уровне HTTP, а не БД.
    RETURN;
  END IF;

  -- Явные проверки жизненного цикла. Каждая — отдельная ветка, чтобы в журнале
  -- была понятная причина отказа.
  IF r.burned_at IS NOT NULL
     OR (r.expires_at IS NOT NULL AND r.expires_at <= now())
     OR (r.max_views  IS NOT NULL AND r.view_count >= r.max_views)
  THEN
    INSERT INTO secure_link_views (id, organization_id, link_id, ip_hash, user_agent,
                                   succeeded, failure_reason, viewed_at)
    VALUES (gen_random_uuid(), r.organization_id, r.id, p_ip_hash, p_user_agent, false,
            CASE
              WHEN r.burned_at IS NOT NULL                                   THEN 'burned'
              WHEN r.expires_at IS NOT NULL AND r.expires_at <= now()        THEN 'expired'
              ELSE 'max_views_reached'
            END,
            now());
    RETURN;
  END IF;

  -- Успех: считаем просмотр и, для одноразовой ссылки, сжигаем её вместе с полезной нагрузкой.
  UPDATE secure_links
     SET view_count  = view_count + 1,
         burned_at   = CASE WHEN kind = 'ONE_TIME' THEN now() ELSE burned_at END,
         payload_enc = CASE WHEN kind = 'ONE_TIME' THEN NULL  ELSE payload_enc END
   WHERE id = r.id;

  INSERT INTO secure_link_views (id, organization_id, link_id, ip_hash, user_agent,
                                 succeeded, viewed_at)
  VALUES (gen_random_uuid(), r.organization_id, r.id, p_ip_hash, p_user_agent, true, now());

  RETURN QUERY
    SELECT r.id, r.organization_id, r.kind::text, r.payload_enc,
           r.resource_type::text, r.resource_id, r.requires_auth, r.password_hash;
END $$;

ALTER FUNCTION secure_link_resolve(bytea, text, text) OWNER TO app_auth;
REVOKE ALL     ON FUNCTION secure_link_resolve(bytea, text, text) FROM PUBLIC;
-- вызывает обычный обработчик запроса, поэтому EXECUTE выдаётся app_user
GRANT  EXECUTE ON FUNCTION secure_link_resolve(bytea, text, text) TO app_user;
```

**Почему `SECURITY DEFINER` здесь безопасен.** Опасность конструкции в том, что тело выполняется с
правами владельца — то есть с `BYPASSRLS`. Безопасной её делают четыре свойства, и все четыре
обязаны сохраняться при любой правке:

1. **Единственный вход — хэш токена.** Функция не принимает ни `organization_id`, ни фильтр, ни
   какой-либо фрагмент SQL. Множество достижимых строк — это множество известных вызывающему
   токенов; знание токена и есть право доступа.
2. **Все проверки внутри, до выдачи данных.** `burned_at`, `expires_at`, `max_views` проверяются в
   той же транзакции, под блокировкой строки. Невозможно получить содержимое, не пройдя проверки,
   и невозможно пройти их дважды на одной одноразовой ссылке.
3. **Невозможно получить данные, не оставив следа.** Запись в `secure_link_views` — часть той же
   транзакции; откат журнала означает откат выдачи.
4. **Фиксированный `search_path` и точечный `GRANT EXECUTE`.** Подмена схемы невозможна; вызвать
   функцию может только `app_user`, а не `PUBLIC`.

Что функция сознательно **не** делает: она не выставляет `app.organization_id` сама.

> **Важная деталь PostgreSQL.** Если у функции есть `SET`-клауза (а `SET search_path` у
> `SECURITY DEFINER` обязателен), то на входе создаётся новый уровень вложенности GUC, и **все**
> изменения конфигурационных параметров, сделанные внутри тела, откатываются при выходе из
> функции — включая `set_config('app.organization_id', …, true)`. То есть контекст, выставленный
> внутри такой функции, снаружи не виден. Проверяется одной командой на своей инсталляции:
>
> ```sql
> CREATE FUNCTION probe() RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog AS $$
> BEGIN PERFORM set_config('app.probe', 'x', true); END $$;
>
> BEGIN;
>   SELECT probe();
>   SELECT current_setting('app.probe', true);   -- NULL → значение откатилось
> ROLLBACK;
> ```

Поэтому контекст выставляет вызывающий код — сразу после возврата, в той же транзакции:

```ts
// application/secure-links/use-cases/open-secure-link.use-case.ts (фрагмент)
export async function openSecureLink(prisma: PrismaClient, input: OpenLinkInput) {
  return prisma.$transaction(async (tx) => {
    const [link] = await tx.$queryRaw<ResolvedLink[]>`
      SELECT * FROM secure_link_resolve(${input.tokenHash}, ${input.ipHash}, ${input.userAgent})
    `;
    // Одинаковый ответ на «нет такой ссылки», «сгорела», «истекла» — иначе эндпоинт
    // становится оракулом состояния чужих ссылок.
    if (!link) throw new NotFoundError('secure_link_not_found');

    // Теперь организация известна: включаем нормальный RLS на остаток транзакции.
    await tx.$executeRaw`SELECT set_config('app.organization_id', ${link.organization_id}, true)`;

    if (link.requires_auth) await assertViewerAuthenticated(tx, link, input);
    if (link.password_hash) await assertLinkPassword(link.password_hash, input.password);

    // Дальше — обычные запросы под RLS: ресурс, вложения, метаданные.
    return link.kind === 'ONE_TIME'
      ? { kind: 'ONE_TIME' as const, payloadEnc: link.payload_enc }
      : { kind: 'RESTRICTED' as const, resource: await loadResource(tx, link) };
  }, { timeout: 5_000 });
}
```

Обязательные внешние ограничения этого эндпоинта: rate-limit по IP **и** по `tokenHash`
(иначе перебор), вырезание токена из логов доступа на уровне nginx и middleware, `Cache-Control:
no-store` в ответе. Сам токен и, для `ONE_TIME`, ключ расшифровки живут во фрагменте URL и до
сервера не доходят — сервер физически не может прочитать содержимое.

### Путь 3. Фоновые воркеры и очереди

Воркер обрабатывает сообщения разных тенантов на одном соединении — то есть это ровно та ситуация,
где утечка контекста между соседними job'ами даёт кросс-тенантную запись.

**Конверт job'а с обязательным `organizationId`:**

```ts
// application/shared/jobs/job-envelope.ts
import { z } from 'zod';

export const jobEnvelopeSchema = z.object({
  organizationId: z.string().uuid(),          // обязателен ВСЕГДА, это конверт, а не payload
  userId: z.string().uuid().nullable().default(null),
  requestId: z.string().min(1),
  causationId: z.string().optional(),
  payload: z.unknown(),
});

export type JobEnvelope = z.infer<typeof jobEnvelopeSchema>;
```

**Обёртка обработчика — единственный разрешённый способ объявить handler:**

```ts
// infrastructure/queue/run-job.ts
export function runJob<T>(
  name: string,
  payloadSchema: z.ZodType<T>,
  handler: (payload: T, tx: TxClient, ctx: TenantContext) => Promise<void>,
) {
  return async (job: Job): Promise<void> => {
    const envelope = jobEnvelopeSchema.safeParse(job.data);
    if (!envelope.success) {
      // Сообщение без tenant-контекста не обрабатывается «как-нибудь» — оно едет в DLQ.
      await deadLetter(job, 'missing_tenant_envelope', envelope.error);
      throw new PermanentError('missing_tenant_envelope');
    }

    const payload = payloadSchema.parse(envelope.data.payload);
    const ctx: TenantContext = {
      organizationId: envelope.data.organizationId,
      userId: envelope.data.userId,
    };

    await requestContext.run(
      { requestId: envelope.data.requestId, organizationId: ctx.organizationId, userId: ctx.userId, job: name },
      // Своя транзакция и свой SET LOCAL на КАЖДОЕ сообщение.
      () => withTenant(prisma, ctx, (tx) => handler(payload, tx, ctx)),
    );
  };
}
```

```ts
// пример использования
export const indexTaskJob = runJob('search-index:task', z.object({ taskId: z.string().uuid() }),
  async ({ taskId }, tx) => {
    const task = await tx.task.findUnique({ where: { id: taskId } });   // уже под RLS
    if (task) await search.upsertTask(task);
  });
```

Три правила, которые обёртка делает неизбежными:

- **Нельзя выставить контекст на пачку.** BullMQ отдаёт job'ы разных организаций вперемешку;
  контекст, выставленный один раз на батч, гарантированно «протечёт» с первого тенанта на
  остальные. Батчинг допустим **внутри** одной организации (например, `embeddings` группирует по
  32 чанка одного тенанта) — тогда группировка делается по `organizationId` до открытия транзакции.
- **Handler, обратившийся к БД мимо `tx`, падает** на `guardedClient` — то есть ошибка находится
  тестом, а не утечкой.
- **Контекст исчезает вместе с транзакцией.** Ничего не нужно сбрасывать вручную; это и есть
  причина, по которой везде `SET LOCAL`, а не `SET`.

**Крон-задачи «по всем организациям»** устроены как явный цикл: список организаций — через
привилегированную функцию, обработка каждой — в своей транзакции со своим контекстом.

```sql
CREATE OR REPLACE FUNCTION tenant_list_organization_ids()
RETURNS TABLE (id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT o.id FROM organizations o WHERE o.deleted_at IS NULL ORDER BY o.created_at
$$;

ALTER FUNCTION tenant_list_organization_ids() OWNER TO app_auth;
REVOKE ALL     ON FUNCTION tenant_list_organization_ids() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION tenant_list_organization_ids() TO app_user;
```

```ts
// infrastructure/queue/for-each-organization.ts
export async function forEachOrganization(
  taskName: string,
  fn: (tx: TxClient, organizationId: string) => Promise<void>,
): Promise<void> {
  const orgs = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM tenant_list_organization_ids()`;
  for (const { id } of orgs) {
    try {
      await withTenant(prisma, { organizationId: id, userId: null }, (tx) => fn(tx, id));
    } catch (error) {
      // Падение на одной организации не должно останавливать остальные.
      logger.error({ error, organizationId: id, taskName }, 'периодическая задача упала на организации');
    }
  }
}
```

Функция возвращает **только идентификаторы** — ничего содержательного она не раскрывает, а
процесс приложения и так знает, какие организации существуют. Запрос «по всем тенантам сразу»
(единый `UPDATE` без фильтра, глобальный отчёт) запрещён; если он всё же нужен для операционной
задачи — это работа `app_migrator` в режиме `app.maintenance = 'on'` с записью в `AuditLog`.

---

## Миграции и RLS

### Политика создаётся в той же миграции, что и таблица

Не «в следующем PR», не «отдельным скриптом при деплое». Между `CREATE TABLE` и `CREATE POLICY` не
должно существовать состояния, в котором таблица есть, а изоляции нет: любой промежуточный деплой,
откат или запуск сидера в этом окне даёт кросс-тенантный доступ.

Prisma генерирует только DDL таблиц, поэтому рабочий процесс такой:

```bash
pnpm prisma migrate dev --create-only --name add_task_checklists   # генерирует SQL, не применяет
# дописываем в тот же файл блок RLS руками
pnpm prisma migrate dev                                            # применяем целиком
```

Полный пример файла миграции:

```sql
-- prisma/migrations/20260726120000_add_task_checklists/migration.sql

-- 1. таблица (сгенерировано Prisma, дополнено составным FK)
CREATE TABLE "task_checklists" (
  "id"              UUID         NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID         NOT NULL,
  "task_id"         UUID         NOT NULL,
  "title"           TEXT         NOT NULL,
  "order_key"       TEXT         NOT NULL,
  "done_at"         TIMESTAMPTZ,
  "created_at"      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "updated_at"      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT "pk_task_checklists" PRIMARY KEY ("id")
);

ALTER TABLE "task_checklists"
  ADD CONSTRAINT "fk_task_checklists_organization"
  FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id") ON DELETE RESTRICT;

ALTER TABLE "task_checklists"
  ADD CONSTRAINT "fk_task_checklists_task"
  FOREIGN KEY ("organization_id", "task_id") REFERENCES "tasks" ("organization_id", "id") ON DELETE CASCADE;

-- 2. индексы: FK проиндексирован, основной сценарий чтения покрыт составным индексом с org первым
CREATE INDEX "idx_task_checklists_org_task_order"
  ON "task_checklists" ("organization_id", "task_id", "order_key");

-- 3. RLS — в той же миграции, без исключений
ALTER TABLE "task_checklists" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "task_checklists" FORCE  ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "task_checklists"
  AS PERMISSIVE FOR ALL TO app_user
  USING      ("organization_id" = current_setting('app.organization_id')::uuid)
  WITH CHECK ("organization_id" = current_setting('app.organization_id')::uuid);

CREATE POLICY "maintenance_access" ON "task_checklists"
  AS PERMISSIVE FOR ALL TO app_migrator
  USING      (current_setting('app.maintenance', true) = 'on')
  WITH CHECK (current_setting('app.maintenance', true) = 'on');

-- 4. права
GRANT SELECT, INSERT, UPDATE, DELETE ON "task_checklists" TO app_user;
```

Отдельная деталь: `prisma migrate diff` и drift-detection сравнивают **схему**, а не каталог
политик. Удалённая вручную политика для Prisma невидима — её видит только сверка с каталогом:
в CI это интеграционный набор (`test/integration/db/migrations.test.ts`), на живом хосте —
`check-rls.ts`, который поэтому запускается после каждого прод-деплоя миграций и после
восстановления из бэкапа.

### Добавление `organization_id` в существующую таблицу

Ровно тот случай, когда легко устроить простой или, наоборот, окно утечки. Пять шагов, каждый —
отдельный деплой (expand → backfill → NOT NULL → policy → contract). Порядок принципиален:
**RLS включается последней**, потому что строка с `organization_id IS NULL` не видна никому
(`NULL = uuid` → `NULL`), и включение политики посреди бэкфила означает мгновенное «исчезновение»
ещё не заполненных строк из приложения.

**Шаг 1 — expand (релиз N).** Nullable-колонка, без ограничений, без блокировок:

```sql
ALTER TABLE legacy_notes ADD COLUMN organization_id uuid;   -- мгновенно: NULL не переписывает таблицу
```

Одновременно деплоится код, который **пишет** новую колонку на всех путях создания и обновления
(двойная запись), но ещё не читает её.

**Шаг 2 — backfill.** Батчами, вне транзакции на всю таблицу, с паузами; исходник значения —
родитель:

```sql
-- выполняется джобом под app_migrator в режиме обслуживания, в цикле до 0 обновлённых строк
WITH batch AS (
  SELECT n.id, t.organization_id
  FROM   legacy_notes n
  JOIN   tasks t ON t.id = n.task_id
  WHERE  n.organization_id IS NULL
  LIMIT  10000
  FOR UPDATE OF n SKIP LOCKED
)
UPDATE legacy_notes n
   SET organization_id = b.organization_id
  FROM batch b
 WHERE n.id = b.id;
```

Между батчами — пауза (100–300 мс), чтобы autovacuum успевал и репликационный лаг не рос.

**Шаг 3 — NOT NULL без длинной блокировки.** Прямой `SET NOT NULL` сканирует таблицу под
`ACCESS EXCLUSIVE`. Обход в два приёма (PostgreSQL 12+ умеет использовать валидное `CHECK`-
ограничение и пропустить скан):

```sql
ALTER TABLE legacy_notes
  ADD CONSTRAINT ck_legacy_notes_org_not_null CHECK (organization_id IS NOT NULL) NOT VALID;   -- мгновенно

ALTER TABLE legacy_notes VALIDATE CONSTRAINT ck_legacy_notes_org_not_null;                      -- SHARE UPDATE EXCLUSIVE, не блокирует чтение/запись

ALTER TABLE legacy_notes ALTER COLUMN organization_id SET NOT NULL;                             -- скан не нужен, ограничение уже валидно
ALTER TABLE legacy_notes DROP CONSTRAINT ck_legacy_notes_org_not_null;                          -- больше не нужно
```

Тогда же — FK и индекс, оба в неблокирующем варианте:

```sql
ALTER TABLE legacy_notes
  ADD CONSTRAINT fk_legacy_notes_organization
  FOREIGN KEY (organization_id) REFERENCES organizations (id) NOT VALID;      -- мгновенно
ALTER TABLE legacy_notes VALIDATE CONSTRAINT fk_legacy_notes_organization;    -- без ACCESS EXCLUSIVE

CREATE INDEX CONCURRENTLY idx_legacy_notes_org ON legacy_notes (organization_id);
```

`CREATE INDEX CONCURRENTLY` не работает внутри транзакционного блока, а Prisma оборачивает
миграцию в транзакцию — поэтому такие миграции помечаются директивой отключения транзакции либо
выносятся в отдельный операционный скрипт (см. правила `db-reviewer` в `stack.md`).

**Шаг 4 — policy (релиз N+1).** Только теперь, когда `NOT NULL` гарантирован:

```sql
ALTER TABLE legacy_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_notes FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON legacy_notes
  AS PERMISSIVE FOR ALL TO app_user
  USING      (organization_id = current_setting('app.organization_id')::uuid)
  WITH CHECK (organization_id = current_setting('app.organization_id')::uuid);
CREATE POLICY maintenance_access ON legacy_notes
  AS PERMISSIVE FOR ALL TO app_migrator
  USING      (current_setting('app.maintenance', true) = 'on')
  WITH CHECK (current_setting('app.maintenance', true) = 'on');
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_notes TO app_user;
```

Перед включением — контрольный запрос, который обязан вернуть ноль:

```sql
SELECT count(*) AS orphans FROM legacy_notes WHERE organization_id IS NULL;
```

**Шаг 5 — contract (релиз N+2).** Снятие двойной записи, удаление старого пути чтения, добавление
таблицы в реестр `tenant-tables.ts` (что автоматически включает её в isolation-набор — и набор
обязан позеленеть до мержа).

### Почему `CREATE POLICY` не блокирует — и что всё-таки нужно учесть

`CREATE POLICY`, `ALTER TABLE … ENABLE/FORCE ROW LEVEL SECURITY` — операции **чисто каталожные**:
они не переписывают таблицу, не сканируют данные и не строят индексов. Их время выполнения не
зависит от объёма таблицы и составляет доли миллисекунды. Именно поэтому включение RLS на
150-миллионной `audit_logs` ничем не отличается от включения на пустой таблице.

Единственное, что нужно помнить: обе команды берут `ACCESS EXCLUSIVE`-блокировку на момент
изменения каталога. Сама по себе она мгновенна, но встаёт в очередь блокировок — а очередь в
PostgreSQL блокирующая: если в этот момент выполняется долгий `SELECT`, наш `ALTER` встанет за
ним, и **все последующие запросы встанут за нашим `ALTER`**. Это и есть типичный сценарий
«миграция положила прод на две минуты» — не из-за самой команды, а из-за очереди. Защита
стандартная и обязательная:

```sql
SET lock_timeout = '3s';   -- уже стоит на роли app_migrator; в миграции дублируем явно
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
```

При таймауте миграция падает, деплой повторяется — это лучше, чем накопить очередь. Для особо
горячих таблиц применяется цикл «попытка → 3 с → повтор» (retry-обёртка в скрипте деплоя).

### Проверка политики на снапшоте прод-объёма

Политика, которая корректна, но убивает планы, — такой же инцидент, как отсутствующая политика.
Регламент проверки перед выкаткой изменения в RLS или в индексах [T]-таблицы:

1. Снять анонимизированный дамп прод-объёма (или сгенерировать синтетику того же порядка:
   ~50 организаций, одна из них в 10 раз крупнее остальных — перекос обязателен, иначе не видно
   проблем планировщика).
2. **Дамп снимается суперпользователем или ролью с `BYPASSRLS`.** С `FORCE ROW LEVEL SECURITY`
   `pg_dump` под владельцем либо падает, либо (с `--enable-row-security`) выгружает **неполные**
   данные без предупреждения. Это относится и к регулярным бэкапам — см. раздел про риски.
3. Восстановить в staging, применить миграцию, прогнать `check-rls.ts` и весь isolation-набор.
4. Снять планы ключевых запросов **под ролью `app_user` и с выставленным контекстом** — под
   владельцем план другой, и мерить его бессмысленно:

   ```sql
   BEGIN;
     SELECT set_config('app.organization_id', '…', true);
     EXPLAIN (ANALYZE, BUFFERS, VERBOSE)
       SELECT id, title, order_key FROM tasks
       WHERE board_column_id = '…' AND deleted_at IS NULL
       ORDER BY order_key LIMIT 100;
   ROLLBACK;
   ```

5. Сравнить с базовой линией из предыдущего релиза (планы хранятся в
   `docs/runbooks/query-baselines/`). Регресс > 30 % по времени или смена `Index Scan` на
   `Seq Scan` — блокирующее замечание.

---

## Производительность

### `organization_id` — первая колонка составных индексов

Предикат RLS присутствует в **каждом** запросе к [T]-таблице, всегда в форме равенства. Значит
индекс, у которого `organization_id` стоит первым, обслуживает одновременно и предикат политики, и
прикладной фильтр — одним проходом:

```sql
-- главный индекс продукта: отрисовка колонки канбана
CREATE INDEX idx_tasks_board_order
  ON tasks (organization_id, board_column_id, order_key)
  WHERE deleted_at IS NULL;
```

Если поменять порядок на `(board_column_id, organization_id, …)`, индекс всё ещё применим, но
отсечение чужих тенантов происходит **после** обхода части индекса, а не до; на инсталляции с
одной крупной организацией разницы не видно, на инсталляции с полусотней — видно сразу.

Практическое следствие для всей кодовой базы: составной индекс на [T]-таблице, не начинающийся с
`organization_id`, требует обоснования в PR (бывают легитимные случаи — например,
`uq_files_storage_key`, где ключ глобально уникален по построению).

### Что политика делает с планом запроса

- Предикат политики добавляется к запросу как обычный `WHERE`-квал; на `EXPLAIN` он виден как
  `Filter: (organization_id = (current_setting(...))::uuid)` или, при удачном индексе, как
  `Index Cond`. Дополнительного узла плана RLS не создаёт.
- `current_setting()` объявлена `STABLE`. Это значит: значение вычисляется **один раз на
  выполнение запроса**, а не на строку, и может использоваться как ключ индексного поиска.
  Опасение «RLS вызывает функцию миллион раз» беспочвенно.
- **Но:** `STABLE`-функция — это runtime-константа, а не plan-time константа. Планировщик не знает
  её значения на этапе планирования и не может свериться со статистикой (`MCV`, гистограммы). Для
  `organization_id` он берёт усреднённую селективность `n_distinct`. На инсталляции, где одна
  организация содержит 95 % строк, это приводит к недооценке или переоценке на порядок — и,
  например, к выбору `Nested Loop` там, где нужен `Hash Join`.

**Как с этим жить — главное правило проекта:** приложение **всё равно** фильтрует по
`organizationId` явно, в самом запросе. Prisma-репозитории добавляют `where: { organizationId }` не
«на всякий случай», а именно ради планировщика: литерал в запросе даёт настоящую константу, по
которой работает статистика, а предикат RLS становится тавтологически истинным и почти бесплатным.
RLS при этом остаётся сетью безопасности — ровно та роль, для которой она заведена. Забытый
`where` перестаёт быть утечкой и становится просто «медленнее, чем могло бы быть».

Прочие эффекты, о которых стоит знать:

- Предикаты политики применяются **раньше** пользовательских условий, если те не помечены
  `LEAKPROOF` (большинство операторов сравнения — `LEAKPROOF`, а `ILIKE`, приведения типов и
  пользовательские функции — нет). Практический вывод: сообщение об ошибке в пользовательском
  условии не может «просочиться» с данными чужого тенанта, но и переупорядочить фильтры ради
  скорости планировщик не всегда сможет.
- Index-only scan остаётся возможным: `organization_id` входит в индекс, поэтому проверка
  политики не требует обращения к куче.
- `pgvector`/HNSW: ANN-индекс возвращает k ближайших соседей **до** применения фильтра политики,
  поэтому после фильтрации их может остаться меньше k. Компенсация — запрашивать `k × 4` и
  досекать в приложении (уже зафиксировано в открытом вопросе №6 модели данных); при росте —
  партиционирование `embeddings` по `organization_id`.
- Стоимость `set_config` — один дополнительный round-trip на транзакцию (в `withTenant` их два:
  организация и пользователь). При 100 транзакциях в секунду это 200 лишних round-trip'ов; на
  локальной сети это доли процента, но на межзонной задержке 5 мс это уже заметно. Отсюда правило
  «одна транзакция на сценарий, а не на запрос» — оно же экономит и pinning соединения.

### Частичные индексы

Там, где политика сочетается с постоянным дополнительным условием, частичный индекс сокращает и
размер, и глубину дерева:

```sql
-- «просрочено» — читается часто, покрывает малую долю строк
CREATE INDEX idx_tasks_org_due
  ON tasks (organization_id, due_at)
  WHERE completed_at IS NULL AND deleted_at IS NULL;

-- непрочитанные уведомления: 99 % таблицы в индекс не входит
CREATE INDEX idx_notifications_user_unread
  ON notifications (organization_id, user_id, created_at DESC)
  WHERE read_at IS NULL;

-- очередь outbox: обработанные события (99 %) в индексе отсутствуют
CREATE INDEX idx_outbox_pending
  ON outbox_events (status, available_at)
  WHERE status IN ('PENDING', 'FAILED');
```

Обратите внимание на последний: у него `organization_id` **не** первым и его вообще нет — это
осознанное исключение. Диспетчер outbox выгребает события всех организаций (и лишь затем
обрабатывает каждое в своём контексте), поэтому индекс по тенанту тут только мешал бы. Такое
исключение допустимо ровно потому, что чтение идёт под тем же `app_user` и политика всё равно
отсечёт чужое — то есть диспетчер обязан работать **по организациям**, а не «по всей очереди».
Единый список job'ов формируется вызовом `tenant_list_organization_ids()` + цикл (см. путь 3).

### Замер на реалистичном объёме

Минимальный набор, который гоняется перед релизом на снапшоте:

| Запрос | Целевое время (p95) | Что проверяем |
|---|---|---|
| колонка канбана, 100 задач | < 15 мс | `Index Scan` по `idx_tasks_board_order` |
| лента комментариев сущности, 50 строк | < 15 мс | частичный индекс, отсутствие `Sort` |
| список сделок с фильтрами и `COUNT(*)` | < 80 мс | план `COUNT` отдельно, кеш 10 с |
| дневной rollup по организации | < 500 мс | агрегат по `time_rollup_daily` |
| ANN-поиск по `embeddings`, k = 20 | < 120 мс | over-fetch k×4 и досечка |

Дельту, вносимую именно RLS, измеряем сравнением того же запроса под `app_user` (с контекстом) и
под ролью с `BYPASSRLS` (с явным `WHERE organization_id = …`). На корректно проиндексированных
запросах разница держится в пределах единиц процентов; если она больше — виноват не RLS, а
отсутствующий или неправильно упорядоченный индекс.

---

## Чек-лист «новая таблица»

Копируется в `.github/pull_request_template.md`. Все пункты обязательны для **[T]**-таблицы;
для **[G]** обязателен пункт 0 с письменным обоснованием.

```markdown
### Tenancy / RLS
- [ ] 0. Таблица помечена [T] или [G] в `docs/architecture/data-model.md`; для [G] — обоснование в описании PR
- [ ] 1. Колонка `organization_id uuid NOT NULL` + FK на `organizations`
- [ ] 2. Составной FK `(organization_id, parent_id)` на родителя (там, где есть родитель)
- [ ] 3. Индекс: FK проиндексирован, основной сценарий чтения покрыт составным индексом,
         начинающимся с `organization_id`
- [ ] 4. `ALTER TABLE … ENABLE ROW LEVEL SECURITY;`
- [ ] 5. `ALTER TABLE … FORCE  ROW LEVEL SECURITY;`
- [ ] 6. Политика `tenant_isolation` для `app_user` с **USING и WITH CHECK**, оба условия идентичны
- [ ] 7. Политика `maintenance_access` для `app_migrator`
- [ ] 8. Явные `GRANT` для `app_user`; для журнальных таблиц — `REVOKE UPDATE, DELETE, TRUNCATE`
- [ ] 8a. `GRANT SELECT ON <table> TO backup_role;` — иначе таблица молча выпадет из `pg_dump`
- [ ] 9. Таблица добавлена в реестр `tenant-tables.ts` и в `ROW_FACTORIES` (иначе не компилируется)
- [ ] 9a. Репозиторий наследует `TenantScopedRepository`; ни один его метод не принимает
         `organizationId` и не принимает транзакцию — и то и другое берётся из скоупа
- [ ] 10. Isolation-тест зелёный именно для этой таблицы (не «вообще»), и в нём есть
         положительный контроль: чтение, список, счётчик, **вставка**, запись и удаление
         **своей** строки. Контроль на `INSERT` обязателен отдельно: `42501` — это и нарушение
         политики, и `permission denied`, поэтому одна негативная проверка проходит и на таблице,
         где `app_user` не получил `INSERT` вовсе
- [ ] 11. `pnpm check:rls` проходит; политика создана в **той же** миграции, что и таблица
- [ ] 12. Никаких plaintext-секретов; всё чувствительное — `*Enc`
```

---

## Известные ограничения и остаточные риски

Перечислены честно: это то, от чего описанная схема **не** защищает.

**1. SQL-инъекция под `app_user`.** RLS ограничивает такую инъекцию одним тенантом — уже
принципиально лучше, чем ничего. Но внутри тенанта инъекция читает всё: приватные проекты, vault-
метаданные, ставки, аудит, — потому что policy-слой живёт в приложении и в SQL не существует.
Кроме того, инъекция может вызвать `secure_link_resolve` (у `app_user` есть `EXECUTE`). Митигации:
запрет `$queryRawUnsafe` линтером, параметризация во всех тегированных шаблонах, минимальный
список `EXECUTE`-грантов, обязательный `security-auditor` в commit-гейте.

**2. Ошибка в самой политике.** `USING (true)`, опечатка в имени GUC, политика, навешенная на
`PUBLIC` вместо `app_user`, забытый `FORCE` — каждая из этих однострочных ошибок открывает
таблицу целиком и не проявляется функционально. Единственная защита — машинная: сверка каталога с
каноническим предикатом (в CI — `test/integration/db/migrations.test.ts`, на живом хосте —
`check-rls.ts`; шаблон у них общий), isolation-тесты с положительным контролем и агент
`tenancy-rls-auditor`. Ручное ревью здесь ненадёжно: 95 почти одинаковых блоков SQL читаются
по диагонали.

**3. `BYPASSRLS` у `app_auth`.** Это единственная роль в системе, обходящая изоляцию. Её реальная
граница — не атрибут роли, а **список выданных ей грантов и список функций, которыми она владеет**.
Расширение этого списка (кто-то добавил ещё одну «удобную» функцию, кто-то выдал `SELECT` на
таблицу) молча расширяет и поверхность обхода. Правила: функции `app_auth` перечислены в этом
документе, любое добавление проходит через `tenancy-rls-auditor`, `EXECUTE` выдаётся точечно, а не
`PUBLIC`, и на все три функции стоит rate-limit на HTTP-уровне.

**4. Суперпользователь и владелец инсталляции.** `postgres`, `app_migrator` в режиме
обслуживания, доступ к диску, реплике или бэкапу — всё это вне зоны действия RLS. Для self-hosted
продукта это не уязвимость, а модель: владелец инстанса имеет доступ к данным всех организаций на
своём сервере. Если инсталляция обслуживает юридически независимые компании, единственный честный
ответ — отдельная база или отдельный инстанс (открытый вопрос №3 модели данных). Компенсация в
текущей схеме: `app.maintenance = 'on'` требует явного включения, а операции под `app_migrator`
фиксируются в devops-журнале.

**5. `pg_dump` и бэкапы при `FORCE ROW LEVEL SECURITY`.** Дамп, снятый под владельцем таблиц,
либо падает с ошибкой RLS, либо — с флагом `--enable-row-security` — выгружает **частичные
данные**. Второе страшнее: бэкап формально успешен, файл существует, восстановление проходит, а
данных в нём меньше, чем было. Правило: бэкапы снимаются суперпользователем или отдельной ролью с
`BYPASSRLS`, и регламент восстановления обязан включать сверку числа строк по нескольким крупным
таблицам (`docs/runbooks/`).

**6. `COPY FROM` не работает с RLS.** PostgreSQL не поддерживает `COPY … FROM` в таблицу с
включённым row-level security — нужен `INSERT`. Это бьёт по путям массового импорта
(`KbImportJob`, миграция данных из другой CRM, seed больших объёмов): они обязаны использовать
батчевые `INSERT` под `withTenant`, а не быстрый `COPY`. Скорость падает примерно на порядок; для
разовых операций допустим импорт под `app_migrator` в режиме обслуживания.

**7. Глобальные уникальные индексы как оракул существования.** Уникальность проверяется ниже RLS,
поэтому нарушение глобального уникального ключа (`uq_files_storage_key`, `uq_sessions_refresh_hash`,
`uq_secure_links_token_hash`, `uq_organizations_slug`) сообщает о существовании строки, которую
вызывающий видеть не может. Для перечисленных ключей это безопасно, так как значения генерируются
сервером и не угадываются; **правило на будущее**: глобально уникальным может быть только
серверно-сгенерированное случайное значение, никогда — пользовательский ввод. Уникальность
пользовательских значений всегда включает `organization_id` в ключ (`uq_users_org_email`).

**8. Проверки внешних ключей обходят RLS.** Описано выше; закрывается составными FK. Остаточный
риск — таблица, где составной FK забыли: тогда чужой id подтверждается как существующий. Пункт 2
чек-листа и агент проверяют именно это.

**9. Данные вне PostgreSQL.** Meilisearch (изоляция — tenant token и `organizationId` в
документе), Redis (префикс ключа), S3 (префикс `storageKey`), логи, эмбеддинги в промптах LLM,
письма — всё это RLS не покрывает вообще. Каждый из этих каналов изолируется собственным
механизмом и проверяется собственными тестами; RLS не даёт по ним никаких гарантий, и считать
иначе — самая опасная ошибка в рассуждении об этой подсистеме.

**10. Логическая репликация и триггеры.** Публикации логической репликации не применяют RLS
(реплицируется всё), а триггеры выполняются с правами владельца таблицы. Любой новый триггер на
[T]-таблице обязан либо не читать другие таблицы, либо явно фильтровать по `organization_id`
строки-инициатора — на него политика вызывающего не распространяется.
