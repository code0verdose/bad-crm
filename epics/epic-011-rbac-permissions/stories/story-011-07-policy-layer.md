---
id: STORY-011-07
epic: EPIC-011
status: in-progress
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
- [ ] ~~`domain/project/access/project-access.policy.ts`~~ — проектов нет до EPIC-014.
      Эталонная policy — `domain/iam/access/role-assignment.policy.ts`; сколько их сейчас, печатает
      `find packages/server/src/domain -name '*.policy.ts' | wc -l`.
- [ ] ~~`application/project/ports/project-access-reader.port.ts` + адаптер~~ — вынесено в EPIC-014,
      см. «Что вынесено». Прецедент формы уже есть на capability-стороне:
      `application/iam/ports/effective-permissions-reader.port.ts` возвращает факты, а не строку.
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
      ~~`sql-query-count.spec.ts`~~ — счётчик SQL заменён проверкой свойства кода
      (`authorize.test.ts:231`, резолвер не вызван), см. критерий 3.
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

Эталонная policy — `domain/iam/access/role-assignment.policy.ts` вместо `project-access.policy.ts`
из списка задач: проектов не будет до EPIC-014. Число policy здесь не записано намеренно, оно
растёт с каждым доменом; актуальное печатает
`find packages/server/src/domain -name '*.policy.ts' | wc -l`.

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

## Состояние по критериям (сверка по коду, 2026-08-28)

Девять критериев из одиннадцати закрыты и стоят за гейтами. Открытое — ровно то, **у чего сегодня
нет предмета**: ресурсный слой (критерий 5 целиком, ресурсные половины 3 и 4) и запись отказа в
журнал (половина критерия 2). Ни одно из открытого не закрыто заглушкой — см. «Что вынесено».

| # | Критерий | Вердикт | Чем доказано |
|---|---|---|---|
| 1 | Policy — чистая функция, 100 % строк и ветвей | **закрыт** | Запрет импортов I/O в `domain` — ESLint (`eslint.config.js:619-634`, `DOMAIN_HAS_NO_IO`) и `test/unit/architecture/layers.test.ts:90`; пороги 100/100 на `src/domain/**/access/*.policy.ts` и `src/domain/access/**` — `packages/server/vitest.config.ts` (блок `thresholds`); табличные тесты — `test/unit/domain/access/*-policy.test.ts`. Оговорка: `Date.now()` в домене сегодня не встречается ни разу, но **автоматического запрета на него нет** — ни в ESLint, ни в архитектурном тесте; держится докстрингом (`domain/identity/access/mfa-policy.policy.ts:31`) |
| 2 | `Decision` несёт причину; разные `reason` в `problem+json` | **закрыт наполовину** | HTTP-половина закрыта: `deny(reason)` (`domain/access/decision.util.ts:9`), `permission_not_granted` и `insufficient_acl_level` — разные ветви `authorize.util.ts:58,101`, `reason` в теле ответа `presentation/http/error-handler.middleware.ts:119`, схема `DenyReason` в `docs/api/openapi.yaml:3507`, тесты `test/unit/domain/access/authorize.test.ts:107,118`. **Аудитная половина открыта**: `AccessRefusedError` не встречается нигде, кроме error-handler, и в `packages/shared/src/audit/audit-action.enums.ts` нет ни одного действия про отказ — вынесено в EPIC-016 |
| 3 | Порядок проверок: capability → ресурс | **закрыт** (в том, что имеет предмет) | `authorizeWith` вызывает резолвер только после прохода capability и только для права с ресурсным контекстом (`domain/access/authorize.util.ts:154`); доказано `test/unit/domain/access/authorize.test.ts:231,244,255`. Счётчик SQL из формулировки заменён проверкой свойства кода — таблицы `resource_acls` нет, считать нечего; при её появлении (EPIC-014) утверждение проверяется на живом запросе |
| 4 | 404 вместо 403 для чужого и несуществующего | **закрыт наполовину** | Выбор кода сделан в одном месте и это закреплено: `tenant_mismatch` и `resource_not_found` → `${resource}_not_found` (`domain/access/access.errors.ts:50,54`), прямое построение `ForbiddenError`/`NotFoundError` вне хелпера запрещено архитектурным тестом (`test/unit/architecture/access-denial.test.ts:36`), «никогда не подтверждает существование чужого ресурса» — `test/unit/domain/access/assert-allowed.test.ts:77`. **Открыто**: теста на порядок «сначала scope, потом `findById`» нет и быть не может — ни одного `*-access-reader` для ресурса не существует |
| 5 | Access-reader не возвращает сущность | **открыт целиком** | Предмета нет: под `application/**/ports/` нет ни одного ресурсного access-reader'а. Форма ответа уже описана типом `AclScope` (`domain/access/authorize.util.ts:16` — «a scope, never the entity»), и прецедент принципа на capability-стороне есть (`application/iam/ports/effective-permissions-reader.port.ts:6` — «no email, no name, no status»), но самого порта, адаптера и архитектурного теста «reader не возвращает агрегат» нет. Вынесено в EPIC-014 |
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

**Ресурсная половина → [EPIC-014](../../epic-014-project-core/epic.md) (проекты).** Критерий 5
целиком, ресурсные половины критериев 3 и 4. Причина одна и та же, и она же держит
`blocked: true` на
[STORY-011-06](story-011-06-resource-acl.md): ACL — это доступ *к ресурсу*, а первым доменом с
ресурсом и наследованием становится проект. Сегодня `requiredLevel` равен `null` у каждого ключа,
который стоит на маршруте, поэтому каждая ячейка матрицы прав — capability-решение
(`test/permissions/permission-matrix.test.ts`, докстринг «What this cannot see yet»). Что уже
готово к приходу ресурса и переписываться не будет: тип `AclScope` с тремя состояниями
(`resolved`/`missing`/`unavailable`), `authorizeResource` и `authorizeWith`, ветка обхода уровня
владельцем и исключение для `family: 'vault'` — всё покрыто табличными тестами на 100 %.

**Аудит отказов → [EPIC-016](../../epic-016-audit-log/epic.md) (журнал действий).** Вторая половина
критерия 2: «разные записи `AuditLog`». Сегодня в `packages/shared/src/audit/audit-action.enums.ts`
нет ни одного действия про отказ, и это не пробел, а решение: каталог действий сознательно
ограничен тем, что **произошло**, а не тем, что было предпринято, — то же обоснование записано в
`epics/epic-012-employee-management/stories/story-012-07-teams.md`, раздел «Что отложено».
Первая запись «попытка, которая не удалась» меняет смысл журнала и потому принадлежит эпику,
который этот журнал строит, а не доменной истории M2. `DenyReason` для такой записи уже существует
и уже доезжает до клиента — не хватает только приёмника.

**Архитектурный тест «вторая точка вычисления прав» → M3.** Критерий 10 в его автоматической части.
Сегодня роль выполняет агент `permission-matrix-auditor` в commit-гейте, и это не отговорка: пока
собственная policy есть только у `domain/iam` и `domain/identity`, тест искал бы вторую точку там,
где первая одна на всех. Смысл он приобретает с приходом доменов со своими policy (M3, задачи и
документы) — тогда же станет возможно доказать его красным на настоящем нарушении, а не на
фикстуре. Владеющего эпика нет; отслеживается здесь до первой доменной policy вне `iam`.

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
- [ ] Commit-гейт зелёный — прогоняется перед переводом статуса, не этой правкой; последнее
      касание кода истории — `b59eb4d` (2026-08-28)
- [x] Документация обновлена — `docs/security/permission-model.md`, `docs/api/openapi.yaml`
      (схема `DenyReason`, `:3507`), `rules/permissions.mdc`; журнал —
      `docs/brain/2026-08-05--the-first-route-behind-a-right.md` и
      `docs/brain/2026-08-05--fifteen-reasons-are-not-fifteen-codes.md`
- [x] a11y и i18n — серверная история без UI; коды отказа переводятся на обоих языках и закрыты
      гейтом `packages/client/test/i18n/error-codes-parity.test.ts` (перебирает `ERROR_CODES`
      целиком, поэтому три кода этой истории попали в него автоматически)
- [x] **Isolation-тест RLS** — новых таблиц история не заводит; `resource_acls` придёт со
      STORY-011-06 и принесёт свой isolation-тест
- [x] **Permission объявлена** для каждого нового endpoint и проверяется в use-case — обе стороны
      закреплены: реестр ↔ Express ↔ спека (`test/contract/openapi.test.ts:166`), маршрут с `:id`
      называет use-case, и названный класс действительно авторизует
      (`test/contract/acl-coverage.test.ts`, с 2026-08-28)
