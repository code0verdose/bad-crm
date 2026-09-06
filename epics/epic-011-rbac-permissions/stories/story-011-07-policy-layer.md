---
id: STORY-011-07
epic: EPIC-011
status: review
blocked: false
priority: must
estimate: L
---

# STORY-011-07 — Policy-слой, порты доступа и реестр маршрутов

**Как** разработчик Bad CRM **я хочу**, чтобы решение о доступе принималось в единственном месте —
чистой policy-функции домена, возвращающей `Decision { allowed, reason }`, а ни один маршрут не мог
существовать без объявленного права, **чтобы** забытая проверка ломала CI, а не превращалась в IDOR
внутри организации.

## Acceptance (Given/When/Then)

1. **Policy — чистая функция.**
   Given `packages/server/src/domain/project/access/project-access.policy.ts`;
   When гоняется архитектурный тест;
   Then модуль не импортирует Prisma, Express, Redis, `process.env`, не вызывает `Date.now()`;
   покрытие строк и ветвей — 100 % (табличные тесты).

2. **Decision несёт причину, а не «forbidden».**
   Given актор без права `project:update` и актор с правом, но уровнем `VIEWER`;
   When вызывается `canUpdateProject`;
   Then в первом случае `{ allowed: false, reason: 'permission_not_granted' }`, во втором —
   `'insufficient_acl_level'`; `assertAllowed` превращает их в 403 с разным полем `reason` в
   `problem+json` (расширение RFC 9457) и в разные записи `AuditLog`. Формулировка исправлена
   2026-08-05: было «с разными `type`-URI», но `type` выводится из `code`, а `code` — закрытый
   каталог, по которому клиент выбирает перевод; обоснование — `permission-model.md`, §«Слой 5».

   > **Аудитная половина закрыта 2026-09-06.** «Разные записи `AuditLog`» больше не отложены:
   > `Decision` несёт `permissionKey` до обработчика ошибок, отбор пишущихся отказов —
   > `packages/server/src/domain/access/denied-access-audit.policy.ts` (тотальный
   > `Record<DenyReason, …>`, поэтому «разные причины — разные записи» проверяется компилятором, а
   > не памятью), запись — `application/access/use-cases/record-denied-access.use-case.ts`.
   > Доказательства: `test/unit/domain/access/denied-access-audit.policy.test.ts`,
   > `test/unit/application/record-denied-access.use-case.test.ts`,
   > `test/unit/http/denied-access-audit-wiring.test.ts`.
   >
   > Две оговорки, обе намеренные и обе описаны в `docs/security/permission-model.md`, §10,
   > «Отказы». Первая: **записываются не все причины** — конфликты состояния (409) и
   > `acl_resolution_failed` записями не становятся, а `not_authenticated` не имеет ни субъекта,
   > ни арендатора и остаётся счётчиком. Вторая: `resource_not_found` и `tenant_mismatch` пишутся
   > **одним** словом `not_found` — иначе журнал стал бы тем оракулом существования, которым не стал
   > API (инвариант 2). Часть критерия, требующая ACL (`insufficient_acl_level` на живом ресурсе),
   > ждала EPIC-014 и **закрыта 2026-09-06** на проекте — строка 2 таблицы ниже,
   > `test/integration/db/project-read-access.test.ts` («an OBSERVER holding project:update…»).

3. **Порядок проверок: capability → ресурс.**
   Given актор без capability и несуществующий `resourceId`;
   When вызывается `can()`;
   Then отказ происходит до обращения к БД за ACL — запрос к `resource_acl` не выполняется вовсе
   (проверяется счётчиком SQL); по времени ответа «нет права» и «нет объекта» неразличимы.

4. **404 вместо 403 для чужого и несуществующего.**
   Given `access.projectScope(id)` вернул `null` (объекта нет, удалён или чужой тенант);
   When выполняется use-case;
   Then `NotFoundError('resource_not_found')` → HTTP **404**, содержимое объекта не читается ни разу
   (порядок «сначала scope, потом `findById`» проверяется тестом на порядок вызовов).

5. **Access-reader не возвращает сущность.**
   Given `ProjectAccessReaderPort.projectScope(projectId)`;
   When он вызывается;
   Then возвращается только `{ projectId, organizationId, aclLevel, visibility, leadId, isDeleted }`,
   без описания, бюджета и прочих полей; архитектурный тест запрещает reader'у возвращать
   доменные агрегаты.

6. **Middleware — fail-fast, а не авторитет.**
   Given маршрут `PATCH /api/v1/projects/:projectId` с `requirePermission('project:update')`;
   When приходит запрос от актора без capability;
   Then 403 до парсинга тела и до обращения к БД; при наличии capability запрос идёт дальше, и
   **ACL проверяет use-case** — middleware `resourceId` не резолвит.

7. **Реестр маршрутов обязателен.**
   Given `ROUTE_REGISTRY` в `presentation/http/routes/registry.ts`;
   When разработчик регистрирует в Express маршрут, отсутствующий в реестре;
   Then CI падает (сравнение стека Express с реестром), сообщение называет метод и путь.

8. **Негативный сценарий — маршрут без права.**
   Given запись реестра без `permission` и без `public: true`;
   When проверяются типы;
   Then код не компилируется (`satisfies readonly RouteDeclaration[]`); запись с `public: true`, но
   пустым `publicReason` валит тест `route-registry.spec.ts`.

9. **Негативный сценарий — маршрут с `:id` без `aclCheckedIn`.**
   Given запись `{ method: 'DELETE', path: '/projects/:projectId', permission: 'project:delete' }`
   без `aclCheckedIn`;
   When гоняется `acl-coverage.spec.ts`;
   Then тест падает; при указанном `aclCheckedIn` тест проверяет, что такой класс существует и
   вызывает `assertAllowed`.

10. **Негативный сценарий — вторая точка вычисления прав.**
    Given в контроллере появилось `if (user.role === 'admin')` или ручной разбор массива
    `permissions` на клиенте мимо `can()`;
    When гоняется архитектурный тест и агент `permission-matrix-auditor`;
    Then вердикт `FAIL`, коммит блокируется (прямая митигация `R-15`).

11. **Неаутентифицированный и заблокированный vault.**
    Given запрос без сессии → DENY `not_authenticated` → 401; Given vault заблокирован →
    DENY `vault_locked` → 423;
    When выполняется `can()`;
    Then коды и причины соответствуют таблице fail-closed §5.

## Задачи

Список сверен с деревом 2026-08-28. Имена файлов приведены к фактическим: реестр разъехался на
`route-registry.types.ts` (форма объявления) и `route-registry.factory.ts` (сам список), а
`explain-denial.ts` не появился — его роль поделили `refusal-resource.util.ts` (какой ресурс
кодирует отказ) и `access.errors.ts` (какой код и статус). Старые имена оставлены зачёркнутыми,
чтобы поиск по ним приводил сюда, а не в пустоту.

- [x] `packages/shared/src/permissions/can.util.ts` (не `can.ts`) — `CapabilityView` (`:14`),
      `capabilityOutcome` (`:56`), `effectivePermission` (`:68`), `can` (`:136`). Единственная
      лестница: серверный `authorize.util.ts` её транслирует в `DenyReason`, а не пересчитывает.
- [x] `packages/server/src/domain/access/{actor.types,decision.types,decision.util,authorize.util}.ts`
      — `allow`/`deny` (`decision.util.ts:7,9`), `assertAllowed` (`decision.util.ts:25`).
      ~~`decision.ts`~~ → `decision.util.ts`, ~~`explain-denial.ts`~~ → `refusal-resource.util.ts`.
- [x] `packages/server/src/domain/access/access.errors.ts` — исчерпывающая таблица `CODE_FOR`
      (`:42`) `DenyReason` → `ErrorCode`, статус выводится из кода в
      `packages/shared/src/errors/error-code.enums.ts` (`unauthenticated: 401` `:51`,
      `vault_locked: 423` `:124`); `reason` доносит до тела ответа
      `presentation/http/error-handler.middleware.ts:119`.
- [x] `domain/project/access/project-access.policy.ts` — есть с 2026-09-06 (до того проектов не
      было, и эталонной policy служила `domain/iam/access/role-assignment.policy.ts`); сколько их
      сейчас, печатает `find packages/server/src/domain -name '*.policy.ts' | wc -l`.
- [x] Ридер ресурса — `application/access/ports/project-access-reader.port.ts` + адаптер
      `infrastructure/persistence/prisma/project-access-reader.adapter.ts` (2026-09-06, STORY-011-06);
      лежит под `access`, а не под `project`, и остаётся там — его единственный потребитель это
      резолвер (докстринг порта). Прецедент формы на capability-стороне —
      `application/iam/ports/effective-permissions-reader.port.ts`: факты, а не строка.
- [x] `packages/server/src/presentation/http/middleware/require-permission.middleware.ts` —
      `createPermissionMiddleware`, строит актора и отказывает до тела запроса и до чтения ресурса.
- [x] `packages/server/src/presentation/http/route-registry.types.ts` (`RouteDeclaration` как union
      из трёх форм) + `route-registry.factory.ts` (`satisfies readonly RouteDeclaration[]`, `:348`).
      Гварды монтируются обходом реестра, а не руками у маршрута.
- [x] Тесты (фактические имена — `*.test.ts`, не `*.spec.ts`):
      `test/unit/domain/access/{authorize,assert-allowed,refusal-resource}.test.ts`,
      `test/unit/domain/access/*-policy.test.ts` (табличные, порог 100/100),
      `test/unit/http/route-registry.test.ts`, `test/contract/acl-coverage.test.ts`,
      `test/contract/route-authorization.test.ts`, `test/contract/openapi.test.ts`,
      `test/permissions/permission-matrix.test.ts`.
      ~~`sql-query-count.spec.ts`~~ — до 2026-09-06 счётчик SQL заменяла проверка свойства кода
      (`authorize.test.ts:231`, резолвер не вызван); живой счётчик есть с этого дня —
      `test/integration/db/project-read-access.test.ts` (имя из состава не взято: суффикс `spec`
      ни один раннер сервера не запускает), см. критерий 3.
      ~~`no-second-authorization-point.spec.ts`~~ — вынесено, см. «Что вынесено».
- [x] Агент `permission-matrix-auditor` в `.claude/agents/permission-matrix-auditor.md` + строка в
      commit-гейте (`CLAUDE.md`, таблица гейта; [EPIC-002](../../epic-002-ci-and-commit-gate/epic.md)).

## Что уже сделано (2026-08-05)

Ядро решения — чистая часть истории, у которой нет зависимостей от ещё не существующих таблиц:

- [x] `domain/access/{actor.types,decision.types,decision.util,access.errors,authorize.util}.ts` —
      `Decision`, `allow`/`deny`/`assertAllowed`, исчерпывающая таблица `DenyReason` → HTTP,
      `authorizeWith` с ленивым резолвером ACL (acceptance 1–5, 11 в части кодов).
- [x] `reason` в `problem+json` (сериализатор, error-handler, схема `DenyReason` в спеке),
      три недостающих кода ошибок с переводами (acceptance 2 — с исправленной формулировкой выше).
- [x] Табличные тесты §5 целиком + проверка порядка «capability → ресурс» через невызванный резолвер.

- [x] (2026-08-05, вместе с STORY-011-04) `require-permission.middleware` и монтирование гварда из
      реестра: гвард добавляется по объявлению маршрута, а не руками, поэтому «право объявлено и не
      проверяется» нельзя получить, забыв строку. Порядок — аутентификация впереди capability.
- [x] `test/contract/acl-coverage.test.ts`: маршрут с параметром в пути обязан называть
      `aclCheckedIn` (или `ownershipCheckedIn`), и названный класс обязан существовать. Проверено,
      что гейт падает: снятое объявление у одного маршрута роняет тест.

Эталонной policy до 2026-09-06 служила `domain/iam/access/role-assignment.policy.ts` вместо
`project-access.policy.ts` из списка задач: проектов не было до EPIC-014. С этого дня
`domain/project/access/project-access.policy.ts` существует и стоит на первом ресурсном чтении
(см. «Закрыто 2026-09-06» ниже). Число policy здесь не записано намеренно, оно растёт с каждым
доменом; актуальное печатает `find packages/server/src/domain -name '*.policy.ts' | wc -l`.

### Закрыто 2026-08-28 — вторая половина критерия 9 (коммит `b59eb4d`)

`test/contract/acl-coverage.test.ts` до этого дня доказывал только, что строка `aclCheckedIn`
резолвится в существующий класс. Теперь он читает исходник названного класса и требует в нём вызов
авторизации (`assertAllowed|authorizeCapability|authorizeWith|authorizeResource|denyAccess`) — тест
«name a class that authorises something, on every parameterised route». Отказ считается таким же
решением, как разрешение: use-case, который только отказывает (`tenant_mismatch` → 404), проверку
сделал.

Проверка **намеренно сужена до маршрутов с `:id`**, и это записано в самом файле: `ListTeamsQuery` и
`GetOrgChartQuery` носят `aclCheckedIn` и вызова авторизации не содержат — правильно, список
фильтруется в SQL под `withTenant`, и рубеж там RLS. Несужённый гейт был бы красным на двух
корректных классах, а гейт, с которым спорят, удаляют. `rules/permissions.mdc` приведено в
соответствие тем же коммитом.

### Закрыто 2026-09-06 — ресурсная половина, на первом ресурсе модели

Предмет появился: проект (EPIC-014, шаги `1829f14` и `245d601`), и та же дельта закрыла всё, что
здесь ждало его. Policy — `domain/project/access/project-access.policy.ts`: `decideProjectAccess`
(capability через `authorizeWith`, резолвер — только после неё; удалённая строка → `missing`;
`NONE` на цепочке → `resource_not_found`, потому что проект — закрытый контур, STORY-014-03 acc. 6),
`canReadProject`, `projectAddressable`/`assertProjectAddressable`. Первое ресурсное чтение —
`application/project/use-cases/get-project-detail.query.ts`: `scope()` и резолвер до решения,
`detail()` — только после и только для допущенного. Доказательства: табличный тест
`test/unit/domain/project/project-access-policy.test.ts` (38 случаев, покрытие 100/100 порогом
`vitest.config.ts`), порядок портов — `test/unit/application/get-project-detail.query.test.ts`,
форма ридера — `test/unit/architecture/access-readers.test.ts`, живой счётчик и три неразличимых
ответа с контролем — `test/integration/db/project-read-access.test.ts`. Маршрута `project:*` в
этой дельте нет — он следующий шаг, и он же перепишет снапшот матрицы.

## Состояние по критериям (сверка по коду, 2026-08-28; ресурсная половина — 2026-09-06)

Одиннадцать критериев из одиннадцати закрыты и стоят за гейтами в той части, у которой есть
предмет; открытого не осталось, commit-гейт прогнан (DoD). Единственное, что не закрыто и не
закрывается здесь, — автоматический тест критерия 10, вынесенный в M3: его отсрочка потеряла
обоснование 2026-09-06, и это решение человека (см. «Что вынесено»). Запись отказа в журнал (аудитная половина
критерия 2) **закрыта 2026-09-06**, ресурсный слой (критерий 5 целиком, ресурсные половины 2, 3 и
4) — **закрыт в тот же день** на проекте. Ни одно из закрытого не закрыто заглушкой — см. «Что
вынесено»: там теперь история переноса, а не открытый список.

| # | Критерий | Вердикт | Чем доказано |
|---|---|---|---|
| 1 | Policy — чистая функция, 100 % строк и ветвей | **закрыт** | Запрет импортов I/O в `domain` — ESLint (`eslint.config.js:619-634`, `DOMAIN_HAS_NO_IO`) и `test/unit/architecture/layers.test.ts:90`; пороги 100/100 на `src/domain/**/access/*.policy.ts` и `src/domain/access/**` — `packages/server/vitest.config.ts` (блок `thresholds`); табличные тесты — `test/unit/domain/access/*-policy.test.ts`. Запрет часов — `test/unit/architecture/layers.test.ts:143` («keeps domain free of the clock»), ловит обе формы (`Date.now()` и `new Date(...)`) по исходнику со снятыми комментариями, положительный контроль на сам детектор — `:154`. **Ревизия 2026-08-30 (закрыто):** прежняя редакция этой ячейки утверждала, что автоматического запрета нет и правило «держится докстрингом» — оно было закрыто тестом в тот же день 2026-08-28, что и сама сверка, и попало в слепое пятно. В ESLint правила про `Date` по-прежнему нет, и не нужно: чтение часов не требует импорта, поэтому import-based проверки его не видят — гейт по построению архитектурный, а не линтерный |
| 2 | `Decision` несёт причину; разные `reason` в `problem+json` | **закрыт** (ресурсная часть — 2026-09-06) | HTTP-половина закрыта: `deny(reason)` (`domain/access/decision.util.ts:9`), `permission_not_granted` и `insufficient_acl_level` — разные ветви `authorize.util.ts:58,101`, `reason` в теле ответа `presentation/http/error-handler.middleware.ts:119`, схема `DenyReason` в `docs/api/openapi.yaml:3507`, тесты `test/unit/domain/access/authorize.test.ts:107,118`. **Аудитная половина закрыта 2026-09-06**: действия `access.denied` и `access.denial_burst` в `packages/shared/src/audit/audit-action.enums.ts`, отбор — `domain/access/denied-access-audit.policy.ts`, запись — `application/access/use-cases/record-denied-access.use-case.ts`, вызов из `error-handler.middleware.ts`; доказано `test/unit/domain/access/denied-access-audit.policy.test.ts`, `test/unit/application/record-denied-access.use-case.test.ts`, `test/unit/http/denied-access-audit-wiring.test.ts`. Покрыты отказы, несущие `DenyReason`; семейство `denyAccess` (без причины) по-прежнему вне журнала и вне метрики — это остаток STORY-016-02, а не этого критерия. Уточнено 2026-08-30: **счётчик отказов и запись в журнале — разные вещи, и путать их нельзя.** Метрика `permission_denied_total{reason}` существует и работает — объявлена `infrastructure/metrics/prom-client.adapter.ts:59`, инкрементится из `error-handler.middleware.ts:130`, покрыта `test/unit/metrics/permission-denied-metric.test.ts`. Она отвечает «сколько и почему», но не «кто, что и над чем»: ни актора, ни ресурса, ни ключа права в ней нет **намеренно** — метка с идентификатором это серия на сущность (`application/platform/ports/metrics.port.ts:46`). Журнал закрыт. **Ресурсная часть закрыта 2026-09-06 на живом объекте:** `OBSERVER` приватного проекта с правом `project:update` получает `insufficient_acl_level` с ключом в решении — `test/integration/db/project-read-access.test.ts` («an OBSERVER holding project:update is refused as insufficient_acl_level, on the live chain»), та же таблица уровней в `test/unit/domain/project/project-access-policy.test.ts`. Адресат оставшейся работы по семейству `denyAccess` — не весь EPIC-016, а [STORY-016-02](../../epic-016-audit-log/stories/story-016-02-audit-logger-port.md), acceptance 7, где то же расхождение уже записано (`:181-192`) |
| 3 | Порядок проверок: capability → ресурс | **закрыт** (ресурсная половина — 2026-09-06) | `authorizeWith` вызывает резолвер только после прохода capability и только для права с ресурсным контекстом (`domain/access/authorize.util.ts:154`); доказано `test/unit/domain/access/authorize.test.ts:231,244,255`. **Счётчик SQL на живом запросе** — `test/integration/db/project-read-access.test.ts`: актор без `project:read` не вызывает ни одного оператора про проект; с правом — ровно четыре в этом порядке: `scope()` под `FOR SHARE`, ридер неявной таблицы, записи по цепочке одним `WITH chain … JOIN resource_acl`, и сущность последней; вся транзакция — девять операторов (`BEGIN`, уровень изоляции, два `set_config`, четыре чтения, `COMMIT`). Отказы стоят 2 (нет строки, чужая организация), 3 (`PRIVATE` без членства) и никогда не читают сущность; разница в один оператор — свойство резолвера, который останавливается на разорванной цепочке, и она записана в тесте, а не спрятана |
| 4 | 404 вместо 403 для чужого и несуществующего | **закрыт** (ресурсная половина — 2026-09-06) | Выбор кода сделан в одном месте и это закреплено: `tenant_mismatch` и `resource_not_found` → `${resource}_not_found` (`domain/access/access.errors.ts:50,54`), прямое построение `ForbiddenError`/`NotFoundError` вне хелпера запрещено архитектурным тестом (`test/unit/architecture/access-denial.test.ts:36`), «никогда не подтверждает существование чужого ресурса» — `test/unit/domain/access/assert-allowed.test.ts:77`. **Ресурсная половина закрыта 2026-09-06**: порядок «сначала scope и цепочка, потом `detail()`» держит `test/unit/application/get-project-detail.query.test.ts` («reads the scope and the chain, decides, and only then reads the entity»; на каждом из четырёх отказов — «the entity is never read»), а три неразличимых ответа — несуществующий, чужой организации, `PRIVATE` без членства — с положительным контролем на своём `PUBLIC_ORG` доказаны на живой базе в `test/integration/db/project-read-access.test.ts` (все три — `project_not_found`, `reason = resource_not_found`). `NONE` на цепочке проект отвечает тем же кодом, а не `acl_explicit_none` (403) — `closeTheContour` в policy, STORY-014-03 acc. 6 |
| 5 | Access-reader не возвращает сущность | **закрыт** (2026-09-06) | Предмет — `application/access/ports/project-access-reader.port.ts`: `aclFacts(projectId, userId): Promise<ProjectAclFacts \| null>`, где `ProjectAclFacts` это `organizationId`, `visibility`, `memberRole` — три факта для неявной таблицы, ни имени, ни ключа, ни описания. Архитектурный тест `test/unit/architecture/access-readers.test.ts` держит это для **каждого** `*-access-reader.port.ts` под `application/`: возвращаемый тип объявлен в самом файле порта, каждое его поле — из закрытого списка фактов решения (идентификаторы, флаги, уровень, видимость, роль членства), порт не импортирует репозиторные порты, read-модели и `*.entity`; положительный контроль — вымышленный ридер с `name` и `Promise<Task>` ловится обоими детекторами. Форма ответа для policy — `AclScope` (`domain/access/authorize.util.ts:16`), прецедент на capability-стороне — `effective-permissions-reader.port.ts:6` |
| 6 | Middleware — fail-fast, а не авторитет | **закрыт** | `createPermissionMiddleware` (`presentation/http/middleware/require-permission.middleware.ts`) строит актора и зовёт `authorizeCapability`, `:id` не резолвит и ACL не читает; `requiresPermission`/`requiresAuthentication` (`route-registry.types.ts`) решают, что монтируется, и проверены `test/unit/http/route-registry.test.ts:165,170`; фактический исход каждой роли на каждом маршруте снят снапшотом `test/permissions/permission-matrix.test.ts` через живой HTTP-стек |
| 7 | Реестр маршрутов обязателен | **закрыт** | `test/contract/openapi.test.ts:166` — «mounts exactly what the registry declares, and nothing else» и «leaves no registry entry unmounted», сравнение идёт со стеком Express (`test/contract/collect-routes.util.ts`); сверка со спекой в обе стороны — там же, `:60,77` |
| 8 | Маршрут без права не компилируется | **закрыт** | `RouteDeclaration` — union из трёх форм, «ни права, ни причины» невыразимо (`route-registry.types.ts`), реестр закреплён `satisfies readonly RouteDeclaration[]` (`route-registry.factory.ts:348`); пустая/дежурная причина валит `test/unit/http/route-registry.test.ts:81` (public) и `:181` (self-service); ключ вне каталога — `:95` и `test/contract/route-authorization.test.ts:119` |
| 9 | Маршрут с `:id` без `aclCheckedIn` | **закрыт** (вторая половина — 2026-08-28) | Отсутствие имени — `test/contract/acl-coverage.test.ts` («name the use-case…») и `test/unit/http/route-registry.test.ts:109`; несуществующее имя — «name something that exists in the source»; **названный класс без вызова авторизации** — «name a class that authorises something», добавлено коммитом `b59eb4d`. Положительный контроль на непустоту списка параметризованных маршрутов в файле есть |
| 10 | Вторая точка вычисления прав | **закрыт агентом, не тестом** | Гейт сегодня — `.claude/agents/permission-matrix-auditor.md:15` (ищет `if (user.role === 'admin')` в контроллере и ручной разбор `permissions` на клиенте), плюс смежный архитектурный тест на единственную точку выбора 404/403 (`test/unit/architecture/access-denial.test.ts`). Автоматического `no-second-authorization-point` нет — вынесено в M3 |
| 11 | Неаутентифицированный и заблокированный vault | **закрыт в части кодов** | `not_authenticated` — первая ветвь `authorizeCapability` (`domain/access/authorize.util.ts:58`), тест `authorize.test.ts:43`; таблица `CODE_FOR` полна по построению (`Record<DenyReason, …>`, `access.errors.ts:42`), статусы 401 и 423 закреплены `test/unit/domain/access/assert-allowed.test.ts:18,28,64`. Сквозного сценария «vault заблокирован» нет и не будет до M4: контекста `vault` в продукте не существует |

## Что вынесено

Три адресата, ни одного заглушенного критерия. Приём тот же, что в
[STORY-012-07](../../epic-012-employee-management/stories/story-012-07-teams.md): критерий, у
которого нет предмета, **не получает заглушки** — код отказа, который никто не может вызвать, или
поле, которое никогда не меняется, были бы обещанием без теста за ним.

**Ресурсная половина → [EPIC-014](../../epic-014-project-core/epic.md) (проекты) — вернулась
закрытой 2026-09-06** (врезка «Закрыто 2026-09-06» выше; ниже — запись переноса, как она была
сделана). Критерий 5
целиком, ресурсные половины критериев 3 и 4. Причина одна и та же, и она же держала
`blocked: true` на
[STORY-011-06](story-011-06-resource-acl.md): ACL — это доступ *к ресурсу*, а первым доменом с
ресурсом и наследованием становится проект. Каждая ячейка матрицы прав — capability-решение,
потому что middleware зовёт только `authorizeCapability`, а use-case с резолвером на маршруте ещё
не стоит (`test/permissions/permission-matrix.test.ts`, докстринг «What this cannot see yet»);
формулировка «`requiredLevel` равен `null` у каждого ключа на маршруте», стоявшая здесь до
2026-09-06, была неверна и до дельты — `organization:manage_security_policy` несёт `MANAGER` и
стоит на трёх маршрутах. Что уже
готово к приходу ресурса и переписываться не будет: тип `AclScope` с тремя состояниями
(`resolved`/`missing`/`unavailable`), `authorizeResource` и `authorizeWith`, ветка обхода уровня
владельцем и исключение для `family: 'vault'` — всё покрыто табличными тестами на 100 %.

**Аудит отказов — сделан 2026-09-06, вместе с EPIC-016.** Здесь стояло, что действий про отказ в
`packages/shared/src/audit/audit-action.enums.ts` нет ни одного и что первая запись «попытка,
которая не удалась» принадлежит эпику журнала. Первое перестало быть верным: в каталоге есть
`access.denied` и `access.denial_burst`. Второе осталось верным по адресату — работа сделана
в STORY-016-02, acceptance 7, — но не по срокам: она сделана сейчас, а не отложена.

Оговорка о том, что каталог ограничен свершившимся, тоже потеряла силу как общее правило: она уже
имела исключения (`user.mfa_setup_failed`, `user.mfa_recovery_locked_out` — обе про то, что **не**
удалось), и `access.denied` — третье, того же вида. Соседний источник этой же формулировки —
`epics/epic-012-employee-management/stories/story-012-07-teams.md`, раздел «Что отложено», — на
2026-09-06 всё ещё говорит старое; его правит история, которая туда придёт.

**Уточнение адресата, ревизия 2026-08-30.** Формулировка выше («эпику, который этот журнал
строит») читалась как «журнала ещё нет». Это уже неверно: ядро журнала отгружено —
[STORY-016-01](../../epic-016-audit-log/stories/story-016-01-append-only-table.md) в `review`,
таблица `audit_logs` в схеме (`prisma/schema.prisma:718`), рабочий адаптер
`infrastructure/persistence/prisma/audit-log.adapter.ts` с редактированием полей и fail-closed
контрактом смонтирован в контейнере (`infrastructure/bootstrap/container.factory.ts:285`), и
use-case'ы EPIC-011/012 в него уже пишут. Открыто было **не журнал, а действие отказа в закрытом
каталоге** — STORY-016-02, acceptance 7, где заодно решалось, что пишется записью, а что остаётся
только метрикой. **Закрыто 2026-09-06** (врезка под критерием 2). У этой половины критерия 2
открытых пунктов не осталось; ресурсная его часть закрыта в тот же день на живом объекте (строка 2
таблицы).

**Архитектурный тест «вторая точка вычисления прав» → M3.** Критерий 10 в его автоматической части.
Сегодня роль выполняет агент `permission-matrix-auditor` в commit-гейте. Отсрочка обосновывалась
тем, что собственная policy есть только у `domain/iam` и `domain/identity`, а тест искал бы вторую
точку там, где первая одна на всех; **это условие наступило 2026-09-06** — первая доменная policy
вне `iam` (`domain/project/access/project-access.policy.ts`) есть, и на ней можно доказать тест
красным на настоящем нарушении. Адрес M3 при этом не пересмотрен: решает человек, а не эта правка
(правило 4 workflow эпиков). Владеющего эпика нет.

## Ссылки

- [`permission-model.md` §5 «Слой 5 — итоговое решение», fail-closed правила](../../../docs/security/permission-model.md)
- [`permission-model.md` §7 «Реализация по слоям» (а)–(д)](../../../docs/security/permission-model.md)
- [`permission-model.md` §9в «CI-правило „нет маршрута без объявленной permission“», §9г агент](../../../docs/security/permission-model.md)
- [`stack.md`, «Backend: гексагональная архитектура», порты](../../../docs/architecture/stack.md)
- [`ux-architecture.md`, «403 vs 404»](../../../docs/architecture/ux-architecture.md)
- [`threat-model.md`, `T-TENANT-05`, `T-TASK-02`](../../../docs/security/threat-model.md)

## Definition of Done

- [x] Тесты написаны первыми (TDD), проходят, изменённый код покрыт — пороги 100/100 на
      `src/domain/access/**` и на `src/domain/**/access/*.policy.ts` стоят в
      `packages/server/vitest.config.ts`, то есть покрытие этой дельты держится гейтом, а не
      разовым замером
- [x] Commit-гейт — прогнан 2026-09-06 на дельте, закрывшей ресурсную половину:
      `permission-matrix-auditor`, `test-coverage`, `security-auditor`, `commit-hygiene`,
      `production-readiness` — PASS; `stale-claims-auditor` судьёй — три прохода FAIL (устаревшие
      пометки в историях, CLAUDE.md и ссылках, ложный компенсирующий контроль в RR-11, три строки
      этого файла в настоящем времени — все сняты в той же дельте), четвёртый — PASS. Отметка
      поставлена **после** четвёртого прохода; последнее касание кода истории — дельта этого дня
- [x] Документация обновлена — `docs/security/permission-model.md`, `docs/api/openapi.yaml`
      (схема `DenyReason`, `:3507`), `rules/permissions.mdc`; журнал —
      `docs/brain/2026-08-05--the-first-route-behind-a-right.md` и
      `docs/brain/2026-08-05--fifteen-reasons-are-not-fifteen-codes.md`
- [x] a11y и i18n — серверная история без UI; коды отказа переводятся на обоих языках и закрыты
      гейтом `packages/client/test/i18n/error-codes-parity.test.ts` (перебирает `ERROR_CODES`
      целиком, поэтому три кода этой истории попали в него автоматически)
- [x] **Isolation-тест RLS** — новых таблиц история не заводит; `resource_acl` пришла со
      STORY-011-06 (`245d601`, 2026-09-06) со своим isolation-тестом
      (`test/integration/db/resource-acl-reader.test.ts`)
- [x] **Permission объявлена** для каждого нового endpoint и проверяется в use-case — обе стороны
      закреплены: реестр ↔ Express ↔ спека (`test/contract/openapi.test.ts:166`), маршрут с `:id`
      называет use-case, и названный класс действительно авторизует
      (`test/contract/acl-coverage.test.ts`, с 2026-08-28)
