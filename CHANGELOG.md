# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Security fixes are additionally published as GitHub Security Advisories; see
[`SECURITY.md`](SECURITY.md). New or changed environment variables are always listed here **and** in
[`docs/runbooks/upgrade.md`](docs/runbooks/upgrade.md), because self-hosted administrators upgrade
from this file.

---

## [Unreleased]

Релиза нет: версионного тега не существует, образа приложения тоже. Спецификация и декомпозиция
завершены (фаза 0); поверх них поставлены EPIC-001 … EPIC-005. Приложение существует и запускается
из исходников: Express 5 отдаёт `/health`, `/ready` и `/api/v1/meta`, `prisma/schema.prisma` и
первая миграция создают две таблицы с RLS, `docs/api/openapi.yaml` — источник истины контракта, а
SPA на Vite + React 19 поднимается с темой, роутером и оболочкой. Чего нет — перечислено ниже,
в разделе [«Not yet present»](#not-yet-present); коротко: аутентификации и сессий, каталогов
локалей, доменных таблиц кроме `organizations` и `teams`, `Dockerfile` и образа. Поэтому
`docker-compose.yml` по-прежнему поднимает **backing services**, а не Bad CRM: боевой установки из
этого состояния не получится, обновляться пока не с чего и не на что.

### Added — EPIC-005: базовый слой мультиарендности

**Доступ к данным**

- `packages/server/src/infrastructure/persistence/prisma/tenant-scoped.repository.ts` — база
  tenant-scoped репозитория. Единственный путь наследника к БД — `run(operation, work)`, который
  спрашивает tenant-контекст **до** отправки запроса; наследник не может ни получить транзакцию со
  стороны, ни принять `organization_id` параметром. И то и другое — вторая точка правды, а при
  расхождении PostgreSQL не ругается, а молча отдаёт пустую выборку, что читается как «данных нет».
  Трансляция ошибок Prisma живёт там же и не может быть забыта: `P2002` →
  `<resource>_already_exists` (409), `P2025` → `denyAccess(...)` → 404, всё остальное — включая
  нарушение RLS — наружу без изменений (500).
- `.../organization.repository.ts` и `.../organization-row.util.ts` — первый репозиторий на этой
  базе и маппер строки в сущность.
- `packages/server/src/application/platform/ports/unit-of-work.port.ts` +
  `.../persistence/prisma/unit-of-work.adapter.ts` — `UnitOfWorkPort`. Метода «транзакция без
  тенанта» в порту нет: в этой системе транзакция и tenant-скоуп — одно и то же. Адаптер строится
  на базовом Prisma-клиенте (единственное место, которому разрешено открывать транзакцию) и
  вызывает работу без аргументов, чтобы тип транзакции не утёк в слой `application`.
- `.../persistence/prisma/database.factory.ts` — соединение с БД как отдельный шаг старта.
- `IdGeneratorPort` получил `uuid()` рядом с `next()`: `next()` отдаёт ULID для корреляционных
  идентификаторов, а все ключи модели данных — `uuid`.

**Создание организации**

- `packages/server/src/application/organization/use-cases/bootstrap-organization.use-case.ts` —
  организация и её первый владелец создаются **одной** транзакцией, через порты
  `OrganizationRepositoryPort`, `UserRepositoryPort`, `RoleSeederPort`, `UnitOfWorkPort`,
  `IdGeneratorPort`. Идентификатор организации генерируется приложением **до** транзакции, и скоуп
  открывается на ещё не существующую организацию: PostgreSQL требует tenant-контекст до `INSERT`, а
  не после. `SECURITY DEFINER` не понадобился — новой `BYPASSRLS`-поверхности не появилось.
- Проверено на живой БД: атомарность, откат, 409 на занятый `slug` и два негативных контроля —
  через bootstrap-скоуп чужая организация не читается и не пишется.

**Аудит RLS как команда оператора**

- `pnpm check:rls` (`packages/server/scripts/check-rls.ts`) — сверяет каталог PostgreSQL
  (`pg_class`, `pg_policy`) с каноническим шаблоном политики и с реестром `tenant-tables.constant.ts`:
  `ENABLE` + `FORCE`, политика для `app_user` с `USING` **и** `WITH CHECK`, отсутствие политик на
  `PUBLIC`, совпадение каталога, Prisma-схемы и реестра. Строка подключения — из аргумента
  (`pnpm check:rls -- postgresql://…`) или из `DATABASE_URL`; читается только `pg_catalog`, поэтому
  достаточно роли `app_user`. Код возврата: `1` — нарушения, `2` — проверку не удалось выполнить
  (это не «всё в порядке»). Пароль из строки подключения не печатается.
- Нужен именно оператору: интеграционный набор судит миграцию из этого чекаута в своём контейнере,
  а [`docs/security/rls-design.md`](docs/security/rls-design.md) требует прогонять проверку на
  staging **после восстановления из бэкапа**, где контейнер поднять негде. В граф `turbo` задача
  намеренно не заведена: turbo кеширует по содержимому файлов, а состояние чужой базы в хеш не
  входит — получился бы кешированный `PASS` над непроверенной базой.
- `.../persistence/prisma/rls-catalog.constant.ts`, `rls-catalog.util.ts`, `rls-report.util.ts` —
  единственное определение канонического предиката и трёх каталожных запросов; из него читают и
  скрипт, и интеграционный тест миграций. Отдельный тест падает, если характерное для каталога слово
  появится где-нибудь ещё в коде сервера, — вторую копию шаблона нельзя завести незаметно.

### Security — EPIC-005

- **Процесс отказывается стартовать под ролью, обходящей RLS.**
  `.../persistence/prisma/assert-db-role.util.ts` одним запросом к каталогу проверяет пять фактов и
  на любом отказывает: роль не `app_user`, `rolsuper`, `rolbypassrls`, владелец схемы `public`,
  членство в `app_migrator`. Подключение суперпользователем или владельцем схемы работает идеально и
  не фильтрует ничего — ошибка без единого симптома, пока один арендатор не увидит данные другого.
  Проверка стоит **до** `listen`; порядок старта закреплён тестом как `env → logger → database →
  db-role → listen`, а отказ проверен против всех четырёх реальных ролей контейнера (три должны быть
  отвергнуты). Практическое следствие для self-host: инсталляция, где `DATABASE_URL` указывает на
  роль-владельца или на суперпользователя, теперь не стартует — вместо того чтобы тихо работать без
  изоляции.
- `pg_has_role(…, 'MEMBER')`, а не `'USAGE'`: для `NOINHERIT`-роли `USAGE` отвечает `false` там, где
  `SET ROLE` возможен, и проверка прошла бы мимо собственной цели.

### Fixed — EPIC-005

- **Гранты на последовательности выдавались всем подряд.**
  `packages/server/prisma/sql/01-grants.sql` аккуратно классифицировал таблицы — и тут же выдавал
  `app_user` `USAGE, SELECT` на **каждую** последовательность схемы, включая принадлежащие таблицам,
  доступ к которым тот же файл строкой выше закрыл (например `_prisma_migrations`). `USAGE` на чужой
  последовательности двигает её `nextval()`, `SELECT` читает `last_value` — оценку объёма таблицы,
  которую приложению открывать нельзя. Ничего не ломалось: правило просто переставало быть правилом.
  Теперь право следует за владеющей таблицей (`pg_depend` → `pg_class`, `deptype IN ('a','i')`), а
  иначе — `REVOKE ALL`; последовательность без владельца тоже не получает ничего и падает громко при
  первом использовании. `backup_role` сохраняет `SELECT` на всех — этого требует `pg_dump`. Дефект
  воспроизведён тестом до правки; закрыт проверкой живого каталога в обе стороны, включая
  repair-направление (файл — ещё и путь восстановления прав после `pg_restore --no-privileges`).
- **Проверка «политика выдана `PUBLIC`, а не `app_user`» не срабатывала никогда.** Драйвер отдавал
  список ролей политики литералом `{app_user}`, а не массивом, поэтому признак `roles.length === 0`
  не выполнялся ни при каких условиях; остальные утверждения при этом были истинны, и тест
  миграций из EPIC-003 выглядел зелёным по существу. Исправлено приведением `rolname::text` в
  запросе плюс явной ошибкой, если список ролей когда-нибудь снова придёт не массивом. Найдено
  положительным контролем.
- Изоляция получила проверки, которых не было: `LIST` рядом с `COUNT` (политика, фильтрующая агрегат
  и отдающая строки, прошла бы мимо счётчика), положительные контроли на список и на удаление своей
  строки, и тест на то, что tenant-контексты двух одновременных запросов не смешиваются.

### Added — EPIC-004: клиентская оболочка и слои FSD

**Сборка и слои**

- `packages/client/vite.config.ts`, `index.html`, `postcss.config.cjs` — Vite 8 + React 19,
  strict-TypeScript, PostCSS с `postcss-preset-mantine`.
- `packages/client/src/shared/config/fsd-aliases.constant.ts` — алиасы `@app|@pages|@widgets|@units|@shared`
  объявлены **в одном месте** и проецируются в `vite.config.ts`, `tsconfig` и `vitest`; тест сверяет
  проекцию в обе стороны. Универсального `@/*` на клиенте нет: рядом со слоевыми алиасами он давал
  второе написание для любого запрещённого пути и разом обходил все архитектурные запреты.
- `eslint/bad-crm.plugin.js` — правила `require-role-suffix`, `no-foreign-unit-internals`,
  `no-effect-for-derived-state`; в `eslint.config.js` — направление слоёв
  `app → pages → widgets → units → shared`, запрет raw `fetch` вне `shared/api`, запрет
  `import.meta.env` вне `shared/config`, запрет вызова query-хуков в `app/**`, `@mantine/notifications`
  только в `shared/ui/toaster` и композиционном корне. Каждое правило закрыто фикстурой в `test/lint`.

**Дизайн-система**

- Mantine 9 (`@mantine/core`, `hooks`, `notifications`) + `@tabler/icons-react`.
  `src/app/theme/app-theme.config.ts` — палитра `brand`, `primaryShade`, шкалы;
  `src/app/styles/tokens.css` — семантические токены `--bc-*` (поверхность, границы, текст, фокус,
  плотность, длительности) для светлой и тёмной темы через `@mixin light-root` / `@mixin dark-root`.
- Контраст токенов считается тестом по самому файлу токенов для обеих тем, а не проверяется глазами.
- `src/shared/ui/**` — `data-state` (loading / empty / error + retry), `page-header`, `skeletons`,
  `toaster`. Тостер — единственная обёртка над `@mantine/notifications`: одно действие даёт ровно
  один тост, повтор той же ошибки обновляет его по стабильному `id`, а не копит стопку.
- `stylelint.config.js` и `pnpm stylelint` — словарь токенов как исполняемое правило: цвет числом и
  «магический» px запрещены, `@media` — только по `$mantine-breakpoint-*`; исключение — два файла
  списком (`tokens.css`, `global.css`), где токены и объявляются. Подвешен через `lint.dependsOn`,
  поэтому набор задач CI-before-push не меняется.

**Дата-слой**

- `src/shared/api/http.client.ts` — типизированный транспорт `openapi-fetch` + `openapi-react-query`
  поверх типов, сгенерированных из контракта: несуществующий путь не компилируется.
- `auth-middleware.util.ts` — Bearer из памяти; на пачку одновременных 401 приходится **один**
  refresh (общий промис) и ровно один повтор, помеченный заголовком, с двумя независимыми защитами
  от петли. Токен живёт только в памяти — не в `localStorage` и не в доступной скриптам cookie;
  стережёт отдельное правило линтера.
- `idempotency-middleware.util.ts` регистрируется **раньше** auth: ключ должен быть проставлен до
  первой отправки, иначе повтор после refresh придёт с другим ключом и сервер посчитает его новым
  действием.
- `query-client.config.ts` — `retry: 1`, `staleTime: 30_000`, глобальный `MutationCache.onError`,
  который зовёт порт уведомлений с `messageKey` вида `errors.<code>`, а не с текстом; локальный
  `onError` переопределяет глобальный, а не добавляется. `AbortError` ошибкой не считается нигде.
- `shared/lib/enums/query-keys.constant.ts` — типизированная фабрика ключей; массив, собранный
  руками в хуке, роняет проверку. `shared/api/optimistic.util.ts` — снимок, патч, откат и
  инвалидация; удалённый элемент возвращается **на своё место**, а не в конец.

**Роутинг и оболочка**

- `src/app/router.tsx` + файловые маршруты `src/app/routes/**` (`__root`, `_authenticated`,
  `_authenticated/index`, `_authenticated/dashboard`, `_authenticated/$`, `login`), `Register` через
  `declare module`, `defaultPreload: 'intent'`, границы состояний на маршрут — `pendingComponent`,
  `errorComponent`, `notFoundComponent`. Гарды — `src/units/auth/lib/guards/**`; search-параметры
  валидируются Zod-схемами (`shared/lib/validation/list-search.schema.ts` с whitelist-сортировкой,
  `units/*/model/validation/*.schema.ts`), `?redirect=` защищён от open redirect.
- `src/widgets/**` — `app-shell` (сайдбар, шапка, переключатель темы, мобильный `Drawer` с ловушкой
  фокуса, skip-link), `breadcrumbs`, `route-announcer` (заголовок документа и перевод фокуса на `h1`
  при смене маршрута), `app-status`. Страницы `pages/dashboard` и `pages/login` — только композиция.
- `src/app/trusted-types.util.ts` — политика `default` только с `createHTML`; `createScript` и
  `createScriptURL` не определяются вовсе, чтобы браузер закрыл их сам. Устанавливается до
  `createRoot`: под боевой CSP без неё приложение не монтируется — чистая сеть, ответ 200, пустая
  страница.
- `src/app/style-nonce.util.ts` — nonce для `<style>`: `getStyleNonce` для Mantine плюс публикация
  значения в `globalThis.__webpack_nonce__`, потому что `react-remove-scroll` (блокировка прокрутки
  в `Drawer`) пишет свой `<style>` мимо Mantine и был заблокирован `style-src-elem`.
- `packages/client/.size-limit.js` — бюджет бандла проверяется сборкой, а не дашбордом: initial JS
  ≤ 250 kB gzip, initial CSS ≤ 60 kB, плюс отдельная строка на каждый route-чанк.

### Changed — EPIC-004

- **Mantine 7 → 9.** В реестре latest stable — 9.x, 7.17.8 помечен `legacy`. Решение ADR-0006
  («Mantine как единственный UI-kit, CSS Modules, без Tailwind») не переписано — версия оформлена
  датированной поправкой; `stack.md`, `overview.md`, `ux-architecture.md`, ADR-0005,
  `rules/design-system.mdc`, `rules/dependencies.mdc` и `CLAUDE.md` приведены к 9. Побочно:
  `@mantine/form` в 9 несёт встроенный `schemaResolver`, поэтому отдельный
  `mantine-form-zod-resolver` перестал быть каноном и убран из документов до появления первой формы.
- `.nvmrc`: `22.22.1` → `22.22.2`. `jsdom@30`, пришедший с клиентом, объявляет
  `^22.22.2 || ^24.15.0 || >=26.0.0`, а runner ставит ровно закреплённую версию — установка падала
  на CI и проходила на всех машинах разработчиков, потому что `nvm use` разрешает `22` в новейшую
  установленную. Preflight теперь один раз сообщает о расхождении пина и текущей оболочки —
  предупреждением, не отказом.
- `--bc-text-muted` — `gray-7` / `dark-1` вместо `gray-6` / `dark-2` из `ux-architecture.md`:
  измеренный контраст прежней пары — 3.32:1 на белом и 4.03:1 на `dark-7`, обе половины ниже 4.5:1.
  Права оказалась реализация; документ приведён к коду с явной пометкой, что ошибка была в
  спецификации.

### Fixed — EPIC-004

- **Тёмная тема держалась на случайности.** `@mixin light-root` / `@mixin dark-root` были объявлены
  на верхнем уровне `tokens.css`, а не внутри `:root`; миксин дописывает к объемлющему правилу, и
  без него в собранный CSS попадал голый `&`-селектор, который резолвился в `:scope` и совпадал с
  корневым элементом по тонкости спецификации. Три независимые проверки (тест токенов, тест
  контраста, stylelint) читали **исходник**, где всё написано верно. Добавлен тест, компилирующий
  файл через настоящий `postcss.config.cjs` и сверяющий селектор, с положительным контролем на
  верхнеуровневую форму.
- Два правила ESLint не ловили то, что заявляли: `no-effect-for-derived-state` пропускало
  `React.useEffect` (селектор смотрел на `callee.name`, а там `MemberExpression` — правило просто не
  запускалось) и гасилось **любым** комментарием, включая `// TODO`.
- Запрет `@units/*/*` применялся и к самому юниту: `ui` не мог взять хук из своего же `service`, и
  вместе с запретом относительных путей юнит становился невыразим. Разведено правилом, сравнивающим
  импорт с юнитом импортирующего файла.
- `sort` в схеме списков был `z.string()` — значение уходит в запрос к базе, поэтому «любая строка»
  это не валидация. Заменено на whitelist (`sortSchema(keys, fallback)`), `page`/`perPage` — через
  `z.coerce`.

### Added — EPIC-003: скелет сервера, схема БД и контракт API

**HTTP и слои**

- `packages/server/src/main.ts` в три строки; вся последовательность старта вынесена в
  `infrastructure/bootstrap/api-process.factory.ts` со швами `loadEnvironment` / `createLogger` /
  `listen` / `onSignal`, поэтому порядок покрыт тестами. Процесс с битым `.env` печатает **все**
  проблемные переменные и выходит с кодом 1 **до** `listen`.
- `infrastructure/bootstrap/shutdown.factory.ts` — graceful shutdown по `SIGTERM`: сначала снимается
  готовность (балансировщик уводит трафик), затем `server.close()`, дожидание текущих запросов,
  закрытие ресурсов, выход 0; через 30 с — принудительный выход 1 со строкой в логе. Повторный
  сигнал ничего не запускает второй раз.
- Гексагональные слои `domain` / `application` / `infrastructure` / `presentation`; направление
  зависимостей, имена файлов и конвенции Express 5 (нет `asyncHandler`, нет `try/catch` в
  контроллерах, нет безымянных wildcard) проверяются архитектурными тестами, а не ревью.
  `presentation` не импортирует `infrastructure`: контекст запроса объявлен портом, реализация — на
  `AsyncLocalStorage`.
- `presentation/http/route-registry.factory.ts` — маршрут нельзя зарегистрировать голым
  `router.get(...)`: таблица маршрутов это данные, и у каждой строки есть либо объявленная
  permission, либо записанная причина быть публичной. Самой проверки прав в ней нет: все три
  существующих маршрута публичны, каждый — с указанной причиной.

**Endpoints**

- `/health` — «процесс жив», ничего не спрашивает у зависимостей; `/ready` — «можно слать трафик»,
  учитывает состояние остановки и выключенные опциональные сервисы. Разделены намеренно: liveness,
  зависящий от базы, превращает медленный запрос в перезапуск контейнера ровно тогда, когда это хуже
  всего.
- `/api/v1/meta` — версия API и время сервера; операция не принимает параметров и **отвергает**
  непрошенные, а не игнорирует их.
- Оба служебных пути лежат вне `/api/v1` и вне контракта — они в явном allow-list контрактного
  теста.

**Ошибки и логи**

- `presentation/http/error-handler.middleware.ts` + `serializers/problem.serializer.ts` — все ошибки
  в одном формате `application/problem+json` (RFC 9457) со стабильным машинным `code`; клиент
  маппит код в перевод. Выбор «404, а не 403» для чужой организации сделан один раз в
  `domain/shared/errors/access-denial.util.ts`, а не на каждом `throw`.
- `infrastructure/logging/pino-logger.adapter.ts` — единственный вызов `pino()`: `redact` по путям,
  сериализатор ошибок вырезает `config.headers`, `mixin` подмешивает контекст запроса. `requestId`
  (ULID) возвращается заголовком и стоит в каждой строке; тела запросов и URL не логируются.
- `packages/shared/src/errors/` — коды `route_not_found` (404) и `payload_too_large` (413);
  `validation-issue.enums.ts` — коды нарушений валидации.

**HTTP-hardening**

- `presentation/http/content-security-policy.util.ts` — политика собирается приложением
  ([ADR-0023](docs/architecture/adr/0023-csp-for-wasm-crypto.md)): `'wasm-unsafe-eval'` в
  `script-src` (крипто-модуль vault — WebAssembly, без этого хранилище не откроется вообще),
  `style-src-attr 'none'`, `trusted-types default` и `require-trusted-types-for 'script'`, origin
  объектного хранилища из `S3_ENDPOINT` в `connect-src`/`img-src`/`media-src`/`frame-src`,
  `frameguard: deny` (helmet по умолчанию даёт `SAMEORIGIN`, что противоречит
  `frame-ancestors 'none'`). `Cross-Origin-Embedder-Policy` не выставляется: `require-corp` ломает
  presigned-вложения ради изоляции, которая этому продукту не нужна. `unsafe-eval` отвергается
  включая фолбэк.
- `cors-origin.util.ts` — allow-list из `APP_URL` и `CORS_EXTRA_ORIGINS`; helmet, `cookie-parser`,
  лимит тела запроса (413).

**База данных**

- `packages/server/prisma/schema.prisma` и первая миграция
  `prisma/migrations/20260727120000_init_tenancy_and_rls/` — `organizations` и `teams`. Две таблицы,
  но с полным набором защит: `ENABLE` **и** `FORCE ROW LEVEL SECURITY`, политика `TO app_user` с
  `USING` **и** `WITH CHECK`, явные `GRANT` (+ `GRANT SELECT … TO backup_role`), `organization_id`
  первой колонкой составных индексов, `uq_teams_org_id (organization_id, id)` как опора составных
  внешних ключей (проверки FK обходят RLS), `SET lock_timeout` / `statement_timeout` в шапке. RLS, политики, гранты и частичные уникальные
  индексы пишутся руками в той же миграции, что создаёт таблицу: `prisma migrate diff` их не видит,
  а между `CREATE TABLE` и `CREATE POLICY` не должно быть состояния, где таблица есть, а изоляции нет.
- `.../persistence/prisma/tenant.context.ts` — `withTenant`: интерактивная транзакция +
  `set_config('app.organization_id', $1, true)` bind-параметром; отсутствие контекста даёт **отказ**
  (`42704`), а не пустую выборку. `tenant-guard.adapter.ts` через `$extends` ловит обращение к
  tenant-таблице вне контекста и называет модель и операцию вместо кода PostgreSQL. Реестр
  `tenant-tables.constant.ts` сверяется с Prisma DMMF в обе стороны.
- Набор изоляции на настоящем PostgreSQL через Testcontainers: чтение, запись, счёт, обновление,
  удаление и попытка «переехать» в чужую организацию — каждый с **положительным контролем** «свою
  строку видно», без которого тест проходит и на сломанном соединении.

**Контракт API**

- [`docs/api/openapi.yaml`](docs/api/openapi.yaml) (OpenAPI 3.1.1) — источник истины; `pnpm api:gen`
  генерирует `packages/client/src/shared/api/schemas/api-schema.d.ts`, который коммитится, а CI
  требует пустой `git diff` после той же команды.
- Контрактный тест сверяет путь × метод спеки и реального Express-роутера **в обе стороны**:
  маршрут без описания и описание без маршрута одинаково валят сборку.
- `presentation/http/middleware/validate.middleware.ts` — zod-валидация `params`/`query`/`body`
  через `safeParse`, тип из `z.output`; `ZodError` разворачивается в `errors[]` с точечным путём
  (`amount.value`, `items[1].title`) и кодами, а не текстами.
- Документы: [`docs/architecture/backend-context-template.md`](docs/architecture/backend-context-template.md)
  и [`docs/runbooks/tracing-a-request.md`](docs/runbooks/tracing-a-request.md).

### Changed — EPIC-003

- `pino` 9.x → 10.x: `pino-http@11` требует `pino@^10`; строка в
  [`stack.md`](docs/architecture/stack.md) приведена в соответствие.
- `test:integration` получил `passThroughEnv` для `DOCKER_HOST`/`TESTCONTAINERS_*`: turbo фильтрует
  окружение, и без этого набор падал на colima/podman, тогда как прямой запуск пакета проходил.

### Security — EPIC-003

- **Каталожная проверка политик добавлена потому, что поведенческий тест этот дефект не видит.**
  У политики `FOR ALL` PostgreSQL при отсутствии `WITH CHECK` подставляет `USING`, поэтому `INSERT`
  чужой строки всё равно отбивается и весь поведенческий набор (55 тестов) остаётся зелёным —
  падает только запрос к `pg_policy.polwithcheck`. То есть «положился на подстановку» и «забыл»
  выглядят одинаково ровно до дня, когда политику разделят по командам, и защита исчезнет.
  Проверка каталога закрывает этот класс.

### Fixed — EPIC-003

- **Скрипт раздачи прав не видел корневую таблицу арендатора.**
  `packages/server/prisma/sql/01-grants.sql` определял tenant-таблицу по наличию колонки
  `organization_id`, а у `organizations` такой колонки нет по устройству — политика сравнивает `id`.
  Таблица не попадала ни в одну ветку и `app_user` не получал на неё **никаких** прав. Проявилось бы
  это не сразу: `pg_restore` идёт с `--no-privileges`, а этот файл объявлен источником истины по
  грантам, поэтому каждое восстановление из бэкапа заканчивалось бы `42501 permission denied for
  table organizations` — вход, определение организации и регистрация переставали работать
  одновременно. Не утечка, а отказ, и ровно там, где чинить некогда. Классификатор переведён на
  `pg_class.relrowsecurity` — то же определение, которое даёт инвариант мультиарендности. Регресс
  закрыт двумя тестами: `REVOKE ALL` → `db:grants` → права восстановлены (на живой базе) и сверка
  списков из SQL с реестром TypeScript, прямо запрещающая возврат колоночной проверки.
- Тест на идемпотентность прав никогда не отзывал их первым, поэтому пропущенная таблица выглядела
  точно так же, как обработанная правильно; это исправлено вместе с самим дефектом.

### Added — EPIC-002: CI, сканеры и гейты ревью

**Пайплайн** (`.github/workflows/`)

- [`ci.yml`](.github/workflows/ci.yml) — четыре джобы. `checks` запускает **ровно ту же одну
  команду**, что и разработчик локально (`pnpm turbo run typecheck lint build test`), плюс
  регенерацию типов API с требованием пустого diff, сверку покрытия с базой и выгрузку отчётов;
  `scan` — gitleaks и сканер мусора; `integration` — набор изоляции БД на настоящем PostgreSQL через
  Testcontainers; `compat` — весь набор на новейшем поддерживаемом Node, вне PR-пути. Node берётся
  из `.nvmrc` через `node-version-file`, pnpm — из `packageManager` через Corepack; отдельный тест
  проверяет, что ни одна из этих версий не повторяется в workflow текстом. Все `uses` пришпилены к
  40-символьным SHA, `permissions: contents: read`, `persist-credentials: false`.
- [`codeql.yml`](.github/workflows/codeql.yml) — статический анализ `javascript-typescript`.
- [`dependency-review.yml`](.github/workflows/dependency-review.yml) — разбор изменений зависимостей
  в pull request.
- [`license-check.yml`](.github/workflows/license-check.yml) — две джобы: лицензии всего
  установленного дерева против allow-list (451 пакет, 0 нарушений) и allow-list build-скриптов;
  аудит уязвимостей с **датированными** исключениями — исключение привязано к GHSA, модулю и списку
  путей, истекает 2026-10-27 и падает, если advisory исчезло, чтобы протухшая строка не пережила
  фикс.
- [`pr-conventions.yml`](.github/workflows/pr-conventions.yml) — commitlint по **каждому** коммиту
  ветки и по заголовку pull request, плюс требование ссылки на историю (`no-story: <причина>`
  принимается, судят ревьюеры).

**Сканеры и гейты в репозитории**

- `.gitleaks.toml` и `scripts/ci/cruft-scan.util.ts` + `pnpm scan:cruft` — сканер секретов и сканер
  мусора живут теперь в проекте, а не в личных настройках: проверка, которой нет у половины
  участников и нет на сервере сборки, — это не проверка. Паттерны BLOCK/WARN и коды выхода 0/1/2
  перенесены дословно, `.cruftignore` разбирается с той же shell-семантикой.
- `coverage-baseline.json` + `pnpm coverage:baseline` — храповик покрытия: просадка относительно
  базы валит сборку, повышение базы — осознанный коммит.
- `test/ci/**` — тесты на **проводку** гейтов, а не на их наличие. Проверяются мутации, каждая из
  которых отключает пайплайн целиком и не видна в ревью: сканер, вызванный с `--staged` (в чистом
  чекауте индекс пуст, то есть всегда успех), расширенный порог кода возврата, код находки, не
  отображённый в отказ, и `|| true` на шаге покрытия — регэксп на `|| true` намеренно не привязан к
  концу строки, потому что `|| true &&` в середине цепочки глушит команду так же полно.
- `test/ci/workflow.test.ts` **читает** [`rules/ci-before-push.mdc`](rules/ci-before-push.mdc) и
  сравнивает множества задач: дрейф в любую сторону — красный тест. Сверх набора правила допускаются
  только объявленные задачи с причиной (`test:integration` требует Docker).

**Управление вкладами**

- [`.github/dependabot.yml`](.github/dependabot.yml) — три экосистемы (npm, github-actions,
  docker-compose), еженедельно, с группировкой patch/minor в один PR, **негруппированными** мажорами
  (мажор читается против migration guide и ревьюится отдельно) и cooldown: свежеопубликованная
  версия не ставится в тот же день, потому что большинство скомпрометированных релизов отзывается за
  несколько суток.
- [`.github/pull_request_template.md`](.github/pull_request_template.md), три шаблона в
  [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/) (пустые issue выключены) и
  [`.github/dco.yml`](.github/dco.yml) — DCO 1.1 вместо CLA, подпись обязательна в том числе для
  мейнтейнеров, remediation-коммит разрешён только автору за себя.

### Security — EPIC-002

- **Исключения в `.gitleaks.toml` были хуже их отсутствия.** Ключ `paths` в глобальном
  `[[allowlists]]` заставляет gitleaks пропускать **весь файл** до применения правил, и
  `condition = "AND"` его не сужает: три сьюта — ровно те, что написаны про обращение с секретами, —
  не сканировались вообще. Конфиг выглядел строгим и был подробно закомментирован; дефект отдало
  только первое исполнение. Исключения переписаны по значению; закрыто положительным контролем —
  подсаженный 40-символьный ключ находится во всех трёх файлах.
- `js-yaml` прижат к пропатченной линии через `pnpm.overrides` — advisory исчезает пересборкой
  дерева, а не оправданием. Для `brace-expansion` override был **применён** и измеримо сломал ESLint
  (`expand is not a function`: 1.x экспортирует функцию, 5.x — именованные члены, а `minimatch@3`
  зовёт по-старому), поэтому там осталось датированное исключение — с приложенным замером, а не с
  предположением.

### Fixed — EPIC-002

- **Верхняя граница `engines.node` (`<23`) молча отключала обновление зависимостей.** Она была
  написана руками и никогда не измерялась; Dependabot запускает npm-updater на Node 24, не мог
  удовлетворить диапазон и отвечал `tool_version_not_supported` на каждый пакет — то есть ни одно
  обновление безопасности не могло открыть pull request. Причина стала видна в логе только после
  публикации репозитория. Набор прогнан на Node 24 целиком и прошёл: граница убрана,
  `engines.node` — `>=22.22.2` без потолка, а заменившее её утверждение проверяется джобой `compat`.
  `.nvmrc` по-прежнему закрепляет версию для разработчиков и CI.
- Паттерн `sk_test_` в сканере мусора не мог сработать никогда: `\b` после `_` не даёт границы слова.

### Added — EPIC-001 (закрытие эпика): проверки dev-стека и preflight

- `pnpm check:services` (`scripts/check-services.ts`) — smoke-проверка стека теми же кредами из
  `.env`, что берёт сервер: PostgreSQL (расширения, четыре роли и их атрибуты), Redis (`PING`),
  MinIO (подписанный `HeadBucket`), Meilisearch (`/health`), SMTP (баннер). Код возврата 1 только
  при отказе **обязательного** сервиса; отключённые опциональные помечаются `SKIPPED`.
- `pnpm dev` предваряется preflight (`scripts/preflight.ts`): называет, чего не хватает и что с этим
  делать; `SKIP_PREFLIGHT=1` — для работы, которой backing services не нужны.
- Раннбуки [`docs/runbooks/hosting.md`](docs/runbooks/hosting.md) (подбор сервера по росту
  компонентов) и [`docs/runbooks/local-environment.md`](docs/runbooks/local-environment.md)
  (диагностика по каждому сервису).
- Реестр читаемых файлов вместо рукописного списка входов turbo: чтения записываются по факту и
  сверяются с `inputs`, поэтому сьют, начавший читать новый файл, не может получить кешированный
  `PASS` над ним. Прямой доступ к файловой системе в `test/**` запрещён линтом.
- [ADR-0023](docs/architecture/adr/0023-csp-for-wasm-crypto.md) — CSP для WebAssembly-крипто.

### Environment variables — EPIC-002 … EPIC-005

Сверено с [`.env.example`](.env.example) и обеими zod-схемами окружения
(`packages/server/src/infrastructure/bootstrap/env.schema.ts`,
`packages/client/src/shared/config/env.schema.ts`); расхождение между ними и шаблоном валит сборку
(`test/env/env-example-sync.test.ts`).

**Появилась одна переменная — только для `docker compose`:**

| Переменная | По умолчанию | Что это |
|---|---|---|
| `MEILI_MAX_INDEXING_MEMORY` | `512Mb` | Потолок памяти Meilisearch при индексации. Собственный дефолт Meilisearch — две трети RAM хоста, то есть на одно-хостовой инсталляции первая полная переиндексация забирает память, на которой работает PostgreSQL, и базу убивает OOM. Размер подбирается под хост — [`docs/runbooks/hosting.md`](docs/runbooks/hosting.md) |

**Ни одна переменная приложения не появилась, не исчезла и не сменила формат.** Список серверных
переменных (`SERVER_ENV_KEYS`) и браузерная схема (единственная `VITE_API_BASE_URL`) те же, что в
разделе EPIC-001; таблицы там остаются актуальными.

**Что изменилось — не имена, а последствия.** С EPIC-001 переменные только разбирались на старте;
теперь часть из них действует:

| Переменная | Что теперь происходит |
|---|---|
| `DATABASE_URL` | Соединение открывается на старте, и **роль проверяется**: суперпользователь, `BYPASSRLS`, владелец схемы `public`, член `app_migrator` или любая роль, кроме `app_user`, — отказ стартовать до открытия порта. Установка, где эта строка указывала на роль-владельца, раньше работала «нормально»; теперь она не запустится, и это намеренно |
| `PORT`, `LOG_LEVEL` | Слушающий порт и уровень pino |
| `APP_URL`, `CORS_EXTRA_ORIGINS` | CORS allow-list |
| `S3_ENDPOINT` | Origin хранилища попадает в `connect-src`/`img-src`/`media-src`/`frame-src` политики CSP |
| `MEILI_HOST`, `SMTP_URL`, `AI_ENABLED`, `OTEL_EXPORTER_OTLP_ENDPOINT` | Определяют отчёт о деградациях в стартовом логе (`search → postgres-fts`, `mail → log`, `ai → disabled`, `tracing → disabled`) |
| `VITE_API_BASE_URL` | Адрес, по которому SPA обращается к API; инлайнится Vite в бандл |

Остальные (`REDIS_URL`, `JWT_SECRET`, `APP_ENCRYPTION_KEY`, ключи S3, `MEILI_MASTER_KEY`,
`MEILI_ENV`, `ARGON2_*`, `RUN_WORKERS_IN_PROCESS`) по-прежнему **валидируются** на старте, но ещё
никем не потребляются: очередей, сессий, шифрования секретов и воркеров в коде нет.

### Commands — EPIC-002 … EPIC-005

Полный список с обоснованиями — [`docs/architecture/stack.md`](docs/architecture/stack.md), раздел
«Команды». Здесь — то, чего не было в EPIC-001.

| Команда | Что делает | Кому |
|---|---|---|
| `pnpm check:services` | Smoke-проверка dev-стека теми же кредами из `.env`, что берёт сервер; отказ только по обязательному сервису, опциональные — `SKIPPED` | Разработчик, установщик |
| `pnpm check:rls` | Сверяет каталог PostgreSQL с каноническим шаблоном политики и с реестром tenant-таблиц на **живом** хосте. Код 1 — нарушения, 2 — проверку не удалось выполнить. Обязателен после восстановления из бэкапа | Оператор |
| `pnpm stylelint` | Словарь токенов: цвет числом, «магический» px и произвольный `@media` запрещены. Подвешен к `lint`, отдельной задачей CI не является | Разработчик |
| `pnpm scan:cruft` | Сканер мусора в дельте (BLOCK/WARN, коды 0/1/2); тот же, что в джобе `scan` | Разработчик, CI |
| `pnpm coverage:baseline` | Сверка покрытия с `coverage-baseline.json` (храповик) | CI |

`pnpm db:bootstrap` и `pnpm db:grants` существуют с EPIC-001 и описаны в таблице переменных выше;
порядок их запуска после миграции и после восстановления — в
[`docs/runbooks/backup-restore.md`](docs/runbooks/backup-restore.md).

### Added — EPIC-001: монорепо и среда разработки

**Монорепо и сборка**

- `package.json`, `pnpm-workspace.yaml`, `turbo.json` — pnpm-workspace с четырьмя пакетами
  (`@bad-crm/shared`, `server`, `client`, `e2e`) и кешируемым turborepo-пайплайном; корневые
  скрипты `dev`/`build`/`typecheck`/`lint`/`test`/`docker:*` — обёртки над `turbo`.
- `tsconfig.base.json` и по одному `tsconfig.json` на пакет — strict, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, project references, алиасы `@/*` (сервер) и
  `@app|@pages|@widgets|@units|@shared` (клиент). Одна версия TypeScript на воркспейс
  ([ADR-0022](docs/architecture/adr/0022-typescript-version-policy.md)).
- `eslint.config.js` + `eslint/bad-crm.plugin.js` — ESLint 9 flat config, единый на все пакеты, с
  архитектурными запретами (гексагональные слои сервера, слои FSD клиента, направление зависимостей
  пакетов, `prisma.*` вне persistence, raw `fetch` вне `shared/api`, `import.meta.env` вне
  `shared/config`, kebab-case + role-suffix). Прогоняется и на `test/**` через корневую задачу
  `//#lint:repo`.
- Prettier, husky, lint-staged, commitlint (Conventional Commits), `.editorconfig`, `.npmrc`,
  `.nvmrc` (Node 22.22.1).
- Покрытие тестами измеряется `@vitest/coverage-v8`; пороги из
  [`rules/testing.mdc`](rules/testing.mdc) §7 роняют сборку.

**Инфраструктура разработки**

- `docker-compose.yml` — PostgreSQL 16 + pgvector, Redis, MinIO (+ `minio-setup`), Meilisearch,
  Mailpit; профили `minimal` / `default` / `full`. Скрипты `scripts/docker/up.sh` и
  `scripts/docker/reset.sh`, команды `pnpm docker:up|down|logs|reset`.
- `packages/server/prisma/sql/00-bootstrap-roles.sql` — роли БД (`app_migrator`, `app_user`,
  `app_auth`, `backup_role`) для инварианта RLS; выполняется до первой миграции.

**Код**

- `packages/shared` наполнен: zod-примитивы (email, пароль, slug, деньги, даты, пагинация,
  сортировка, локаль, таймзона), branded id, каталог permissions с `can()`, коды ошибок, `Result`.
- `packages/server/src/infrastructure/bootstrap` — разбор окружения одной zod-схемой на старте,
  `EnvValidationError` со списком **всех** проблемных переменных, отчёт о деградациях.
- `packages/client/src/shared/config` — отдельная, намеренно маленькая схема окружения браузера.

**Тесты репозитория** (`test/**`)

- `test/repo` — состав workspace, направление зависимостей, контракт tsconfig, версии тулчейна.
- `test/env` — `.env.example` совпадает с объединением серверной и клиентской схем и переменных,
  которые интерполирует compose; в шаблоне нет реальных секретов; серверный секрет не может
  получить имя с префиксом `VITE_`.
- `test/infra` — инварианты `docker-compose.yml` и bootstrap-SQL.
- `test/lint` — архитектурные запреты проверяются линтом намеренно сломанных фикстур, с
  положительным контролем.

### Environment variables — EPIC-001

Полный шаблон — [`.env.example`](.env.example); нормативные описания —
[`docs/runbooks/install.md`](docs/runbooks/install.md). На момент EPIC-001 ни одна из переменных не
читалась работающим приложением — сервер был скелетом; что действует сегодня, перечислено выше в
разделе «Environment variables — EPIC-002 … EPIC-005». Список приведён здесь, потому что этот файл —
то, из чего администратор self-host узнаёт об изменениях окружения.

**Обязательные, без значения по умолчанию — процесс не стартует без них:**

| Переменная | Что это |
|---|---|
| `APP_URL` | Публичный URL инсталляции: CORS, домен cookie, ссылки в письмах. В production обязан быть `https`, кроме loopback |
| `DATABASE_URL` | Строка подключения PostgreSQL для роли приложения (без `BYPASSRLS`) |
| `REDIS_URL` | Строка подключения Redis |
| `JWT_SECRET` | Секрет подписи access-токенов, минимум 32 символа (`openssl rand -base64 48`) |
| `APP_ENCRYPTION_KEY` | 32 байта в base64 (`openssl rand -base64 32`); шифрует секреты интеграций в БД. **Потеря делает их невосстановимыми** |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | Объектное хранилище файлов |

**`NODE_ENV`** (по умолчанию `development`) стоит особняком: он не деградирует функцию, а решает,
запустится ли процесс вообще. Preflight включён на **всём, что не `development`** — включая `test`, —
и отвергает плейсхолдеры `CHANGE_ME`/`dev_` в секретах и `http`-`APP_URL` вне loopback. Область
выбрана по «не development», а не по «production» осознанно: модель угроз (T-SH-01, T-SH-03) считает
любой не-dev запуск доступным из интернета, и деплой, забытый на `NODE_ENV=test`, не должен
стартовать на плейсхолдерном секрете. Практическое следствие: `NODE_ENV=test` с dev-значениями
**ломает старт**, и это не регрессия.

**Опциональные — их отсутствие деградирует функцию, но не ломает старт:**

| Переменная | По умолчанию | Эффект |
|---|---|---|
| `PORT` | `3000` | Порт HTTP-сервера |
| `DATABASE_MIGRATION_URL` | нет | Подключение под ролью-владельцем для `prisma migrate deploy` и `pnpm db:grants`. Процесс приложения её не открывает, поэтому она опциональна для старта, но **миграции без неё не идут**: у `app_user` нет `CREATE` на схеме `public` |
| `S3_REGION` | `us-east-1` | Регион объектного хранилища |
| `S3_FORCE_PATH_STYLE` | `true` | Path-style адресация для MinIO; для AWS S3 — `false` |
| `MEILI_HOST`, `MEILI_MASTER_KEY`, `MEILI_ENV` | нет | Без них поиск падает на PostgreSQL FTS. `MEILI_MASTER_KEY` обязателен, если задан `MEILI_HOST` |
| `SMTP_URL` | нет | Без неё письма пишутся в лог (dev) и падают с внятной ошибкой (prod) |
| `AI_ENABLED` | `false` | Ключи AI-провайдеров живут в БД, а не в env ([ADR-0014](docs/architecture/adr/0014-ai-provider-abstraction.md)) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | нет | Без неё трейсы не экспортируются; логи и метрики работают |
| `CORS_EXTRA_ORIGINS` | нет | Дополнительные origin'ы браузера через запятую, сверх `APP_URL` |
| `LOG_LEVEL` | `info` | `fatal`…`trace` |
| `RUN_WORKERS_IN_PROCESS` | `false` | Исключение для профиля `minimal`: воркеры в процессе API |
| `ARGON2_MEMORY_COST` | `19456` | Параметры argon2id для паролей. Значения `0`, отрицательные и дробные отвергаются на старте |
| `ARGON2_TIME_COST` | `2` | |
| `ARGON2_PARALLELISM` | `1` | |

**Браузерный бандл** (Vite инлайнит только префикс `VITE_`; серверных секретов здесь нет и быть не
может — это проверяется тестом):

| Переменная | По умолчанию | Что это |
|---|---|---|
| `VITE_API_BASE_URL` | `/api/v1` | Адрес API: путь того же origin или абсолютный `http(s)`-URL |

**Только для `docker compose` и скриптов разработки** — приложением не читаются, в production-образ
не попадают: `COMPOSE_PROFILES`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`,
`POSTGRES_PORT`, `APP_MIGRATOR_PASSWORD`, `APP_USER_PASSWORD`, `APP_AUTH_PASSWORD`,
`BACKUP_ROLE_PASSWORD`, `REDIS_PORT`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `MINIO_PORT`,
`MINIO_CONSOLE_PORT`, `MEILI_PORT`, `MAILPIT_MAX_MESSAGES`, `MAILPIT_SMTP_PORT`, `MAILPIT_UI_PORT`.

### Added — Phase 0: спецификация проекта

**Продуктовые документы** (`docs/product/`, 3 файла)

- `prd.md` — проблема и цель, персоны и JTBD, скоуп по MoSCoW, North Star Metric и контрметрики,
  риски R-01…R-15, явный out-of-scope.
- `roadmap.md` — девять майлстоунов M1–M9 с составом эпиков, пользовательской ценностью, критериями
  выхода и зависимостями.
- `glossary.md` — ubiquitous language EN/RU: термин домена = имя Prisma-модели = корень FSD-unit'а =
  имя в контракте API.

**Архитектурные документы** (`docs/architecture/`, 4 файла + 23 ADR)

- `overview.md` — C4 уровни 1–3, ограниченные контексты, сквозные механизмы (tenancy, авторизация,
  outbox, файлы, realtime, поиск, AI, observability), границы доверия, развёртывание.
- `stack.md` — стек с версиями и обоснованиями, раскладка монорепо, гексагональные слои сервера,
  contract-first API, работа с БД и RLS, outbox и очереди, безопасность в коде, конфигурация и env,
  наблюдаемость, тестовая стратегия, команды, политика зависимостей и лицензий.
- `data-model.md` — сущности, таблицы, индексы, RLS-политики; источник истины по именам.
- `ux-architecture.md` — принципы интерфейса, информационная архитектура, карта маршрутов, ключевые
  экраны, дизайн-система, паттерны взаимодействия, права в UI, доступность WCAG 2.1 AA, локализация,
  адаптивность и производительность.
- `adr/0001`…`adr/0021` — 21 запись Architecture Decision Record: монорепо, гексагональный backend,
  OpenAPI как источник истины, мультиарендность через RLS, FSD «units», Mantine + CSS Modules,
  TanStack Router и Query, модель прав RBAC + ACL, иерархия ключей E2EE, Socket.IO + Redis, поиск с
  учётом прав, редактор BlockNote, Markdown как источник истины KB, абстракция AI-провайдера,
  S3-хранилище и presigned URL, единая модель записи времени, Mantine Charts, лицензия AGPL-3.0,
  i18n EN/RU, упаковка для self-host, транзакционный outbox.

**Документы безопасности** (`docs/security/`, 4 файла)

- `threat-model.md` — область моделирования, активы, нарушители N1–N8, границы доверия, STRIDE по
  контекстам, топ-15 угроз, prompt injection, утечка через поиск, presigned URL, supply chain,
  специфика self-host, персональные данные, остаточные риски RR-01…RR-07, план проверки.
- `rls-design.md` — три роли БД и bootstrap, канонический шаблон политики, особые случаи
  (`organizations`, append-журналы, партиции, наследование `organization_id`, представления),
  `withTenant` и `guardedClient`, автоматизация против забывчивости, обязательные isolation-тесты,
  особые пути (логин, анонимная ссылка, воркеры), миграции и RLS, производительность, чек-лист
  «новая таблица», известные ограничения.
- `permission-model.md` — пять слоёв модели (каталог permissions, роли, per-user overrides, resource
  ACL, единая точка вычисления), матрица роль × endpoint, отвергнутые альтернативы.
- `e2ee-design.md` — обещание и его границы, иерархия ключей, параметры примитивов и защита от
  downgrade, что хранится на сервере и что не хранится никогда, полный жизненный цикл (регистрация,
  разблокировка, создание, чтение, шаринг, отзыв и ротация, смена и сброс пароля, офбординг,
  Recovery Kit, org escrow), blind index, защищённые ссылки ONE_TIME и RESTRICTED, интеграция с
  остальной системой, правила для разработчиков, модель угроз vault, план реализации.

**Правила разработки** (`rules/`, 34 файла `.mdc`)

Обязательные всегда (`alwaysApply: true`): `tdd-and-commit-gate`, `ci-before-push`, `commit-hygiene`,
`epic-driven-development`, `agent-orchestration`, `naming-and-structure`, `tenancy-rls`,
`permissions`, `security`, `i18n`, `a11y`, `frontend-fsd`, `hexagonal-backend`, `testing`.

По области изменений: `api-contract`, `zod-validation`, `db-migrations`, `outbox`,
`polymorphic-access`, `tanstack-query`, `lists-and-filters`, `design-system`, `errors-and-toasts`,
`editor-content`, `realtime`, `search-index`, `file-uploads`, `import-export`, `observability`,
`e2ee-crypto`, `ai-providers`, `time-tracking-invariants`, `self-host-packaging`, `dependencies`.

**Проектные агенты-ревьюеры** (`.claude/agents/`, 9 файлов)

`tenancy-rls-auditor`, `permission-matrix-auditor`, `e2ee-crypto-reviewer`,
`openapi-contract-guardian`, `fsd-architecture-linter`, `realtime-event-reviewer`,
`search-permission-auditor`, `i18n-coverage-checker`, `selfhost-upgrade-checker` — каждый только
читает дельту и отчитывается, код не редактирует.

**Декомпозиция работ** (`epics/`, 159 файлов)

- 46 эпиков (`epic.md`) — по одному на каталог `epic-NNN-<slug>/`, с frontmatter
  (`id`/`status`/`blocked`/`milestone`/`owner`), ценностью, scope in/out, критериями приёмки,
  зависимостями и рисками.
- 113 пользовательских историй (`stories/story-NNN-XX-<slug>.md`) — написаны для майлстоунов M1 и M2
  (эпики EPIC-001 … EPIC-017), с критериями Given/When/Then, чек-листом задач и Definition of Done.
  Истории майлстоунов M3–M9 создаются на kickoff соответствующего майлстоуна.

**Корневые документы и runbooks**

- `CLAUDE.md` — рабочее соглашение: три неприкосновенных инварианта, порядок источников истины,
  CI-before-push, карта «какой файл читать когда», стек, workflow эпиков, commit-гейт, команды,
  раскладка пакетов и нейминг, таблица проектных агентов, чувствительность данных.
- `README.md` и `README.ru.md` — публичное описание проекта на английском и русском с честным
  статусом фазы проектирования.
- `CONTRIBUTING.md` — окружение, структура репозитория, обязательный TDD, commit-гейт, Conventional
  Commits, обязательность `rules/*.mdc`, процесс эпиков и историй, код-ревью, DCO 1.1, Definition of
  Done (ключевые разделы продублированы по-русски).
- `SECURITY.md` — поддерживаемые версии, приватный канал приёма уязвимостей и сроки ответа, скоуп и
  out-of-scope, координированное раскрытие за 90 дней, раздел о гарантиях и не-гарантиях E2EE-vault,
  чек-лист безопасной self-host установки.
- `CODE_OF_CONDUCT.md` — Contributor Covenant 2.1.
- `CHANGELOG.md` — этот файл.
- `docs/README.md` — Map of Docs: карта всей документации, схема связей, разделение источников истины.
- `docs/api/README.md` — contract-first флоу, генерация типов, правила изменения контракта.
- `docs/runbooks/install.md`, `upgrade.md`, `backup-restore.md`, `incident.md` — операционные
  инструкции self-host: установка и чек-лист безопасности, обновление и откат, бэкап и
  восстановление, реакция на инциденты.

**Прочее в репозитории**

`LICENSE` (AGPL-3.0), `.editorconfig`, `.gitignore`, `.npmrc`, `.nvmrc` (Node 22).

### Not yet present

Раздел о том, чего в репозитории **нет**, — чтобы список выше не читался как обещание работающего
продукта.

- **Аутентификация и сессии** (EPIC-006). Логина, refresh-эндпоинта и cookie-сессий не существует;
  контекст роутера несёт только `auth.status`, bootstrap сессии нет. Обновление токена на клиенте
  идёт «сырым» запросом мимо типизированного клиента, потому что такой операции нет в контракте;
  исключение помечено тестом, который падает, как только операция в контракте появляется.
- **Права на endpoint'ах** (EPIC-011). Реестр маршрутов объявляет permission или явную причину быть
  публичным, но точки проверки нет — сегодня все три маршрута публичны.
- **Каталоги локалей EN/RU** (EPIC-008). В UI проставлены ключи, переводить их нечем; `i18next` в
  зависимостях отсутствует.
- **Доменная модель.** В схеме только `organizations` и `teams`. Нет `users`, `roles`, журнала
  аудита, outbox и очередей BullMQ, поиска, файлов, задач, документов, времени — при том что
  `bootstrap-organization.use-case.ts` уже объявляет порты `UserRepositoryPort` и `RoleSeederPort`
  под них.
- **Rate limiting** (`rate-limiter-flexible` из [`stack.md`](docs/architecture/stack.md)) — не
  подключён.
- **Полная дизайн-система и Storybook** (EPIC-007); `shared/ui` содержит только то, что понадобилось
  оболочке.
- **Playwright** (EPIC-010): `packages/e2e` — заготовка из одного файла. Джобы e2e в CI намеренно
  нет: обязательная проверка, которая всегда зелёная, вреднее отсутствующей.
- **`Dockerfile` и образ приложения** (EPIC-017). Нет ни установки одной командой, ни прогнанного
  пути `NODE_ENV=production`: сервер и клиент запускаются из исходников, а `docker-compose.yml`
  поднимает только backing services. Поэтому и обновляться по этому файлу пока некому — раздел
  «Environment variables» ведётся с первого дня именно для того, чтобы к этому моменту он был полон.

Соответствие эпиков майлстоунам — [`docs/product/roadmap.md`](docs/product/roadmap.md); текущие
статусы — [`epics/README.md`](epics/README.md).

---

<!--
  Release sections go here, newest first, e.g.:

  ## [0.1.0] — YYYY-MM-DD
  ### Added / Changed / Deprecated / Removed / Fixed / Security
  ### Environment variables
  ### Migration notes
-->
