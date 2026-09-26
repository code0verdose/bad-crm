---
id: STORY-011-06
epic: EPIC-011
status: in-progress
blocked: false
priority: must
estimate: L
---

# STORY-011-06 — ACL на ресурс и наследование по цепочке

**Как** руководитель проекта (P2) **я хочу** выдавать доступ к конкретному объекту — проекту, папке,
документу — конкретному человеку, роли или команде, с уровнем от «смотреть» до «управлять»,
**чтобы** закрыть один документ внутри общего проекта или, наоборот, впустить подрядчика ровно в
одну папку, не трогая роли всей организации.

> **Чем заблокировано (2026-08-07).** ACL — это доступ *к ресурсу*, а ресурсов в продукте ещё нет:
> первым доменом с наследованием станет проект (EPIC-014). Писать таблицу `resource_acls` и правило
> «ближайшая явная запись побеждает» против несуществующего дерева значит проверять их на фикстурах,
> а не на предметной области. Разблокируется на kickoff EPIC-014.
>
> **Блокировка подтверждена ревизией 2026-08-12.** Проверено по коду, а не по борду: модели
> `Project` в `packages/server/prisma/schema.prisma` нет, таблицы `resource_acls` нет,
> `ResourceAcl` встречается в репозитории **только в комментариях**, объясняющих её отсутствие
> (`schema.prisma:403`, `domain/iam/access/team-access.policy.ts:25`), а
> [EPIC-014](../../epic-014-project-core/epic.md) в статусе `backlog`. Причина блокировки не
> устранена и не изменилась.
>
> **Разблокировано 2026-09-06 — kickoff EPIC-014.** Условие, записанное 2026-08-07, наступило:
> проект становится первым доменом с наследованием, и таблица `resource_acl` получает живой
> предмет — цепочку `PROJECT → ORGANIZATION`. Семь историй EPIC-014 предварительно сверены с
> кодом (`304fdd0`, девятнадцать расхождений сняты), порядок работ выведен из зависимостей:
> таблицы проекта → `resource_acl` и резолвер → access-reader проекта и policy → CRUD. Флаг
> `blocked` снят, статус `in-progress`. Заглушек по-прежнему нет — всё ниже строится против
> настоящего дерева.
>
> **Блокировка подтверждена повторно 2026-08-12 → 2026-08-30.** Сверка та же и с тем же исходом:
> `grep -c '^model Project' packages/server/prisma/schema.prisma` печатает `0`, миграции с
> `resource_acl` нет ни одной, EPIC-014 всё ещё `backlog`. Отдельно проверено, что **заглушек
> история не получила** — ни `domain/access/acl-resolution.ts`, ни `implicit-level.ts`, ни каталога
> `application/access/` не существует, `implicitLevel` не встречается в коде ни разу, TODO про ACL
> в `domain/**` и `shared/src/permissions/**` нет. Ключи `acl:read`/`acl:grant`/`acl:revoke` в
> каталоге присутствуют (`permissions.catalog.ts:88-90`) и это не заглушка, а устройство
> STORY-011-01: каталог объявляется закрытым списком заранее — ни один из трёх ключей не стоит ни
> на одном маршруте.

## Acceptance (Given/When/Then)

1. **Выдача и чтение записи ACL.**
   Given руководитель с `acl:grant` и уровнем `MANAGER` на проекте `BAD`;
   When `POST /api/v1/acl` с `{ resourceType: 'PROJECT', resourceId, subjectType: 'TEAM',
   subjectId: teamBackend, accessLevel: 'EDITOR', expiresAt: null }`;
   Then создаётся `ResourceAcl`, инкрементится `permissions_version` **всем членам команды**,
   пишется `acl.granted` в `AuditLog` (`severity = warning`).

2. **Ближайшая явная запись побеждает.**
   Given `PROJECT → TEAM=backend → EDITOR` и `DOC_PAGE(внутри) → USER=ivan → VIEWER`, Иван в команде
   backend;
   When резолвится уровень Ивана на этом документе;
   Then `VIEWER`: обход снизу вверх останавливается на первом узле с записями. Правка запрещена,
   чтение разрешено. Обратная раскладка (`VIEWER` на проекте, `EDITOR` на документе) даёт `EDITOR`
   на этом документе и `VIEWER` на остальных.

3. **`NONE` — явный запрет на узле и ниже.**
   Given `PROJECT → TEAM=backend → EDITOR` и `KB_SPACE → USER=ivan → NONE`;
   When Иван открывает заметку внутри этого пространства;
   Then **404** (`acl_explicit_none` внутри, наружу — `resource_not_found`): существование закрытого
   пространства не подтверждается; все заметки внутри наследуют тот же `NONE`.

4. **Максимум на одном узле.**
   Given на одном узле `TEAM → EDITOR` и `USER → VIEWER` для одного актора;
   When резолвится уровень;
   Then `EDITOR` (максимум); понижение конкретного человека выражается только `NONE` либо записью на
   более близком узле — это зафиксированное ограничение шкалы.

5. **Просроченные записи не учитываются.**
   Given `ResourceAcl(expiresAt = now - 1s)`;
   When резолвится уровень;
   Then запись игнорируется как отсутствующая; при отсутствии других — применяется `implicitLevel`.

6. **`implicitLevel` вместо «разрешено всем».**
   Given ни одной записи ACL по всей цепочке;
   When актор — `ProjectMember(projectRole = MEMBER)` публичного проекта → `EDITOR`;
   `REVIEWER` → `COMMENTER`; `OBSERVER` → `VIEWER`; не участник публичного проекта → `VIEWER`;
   не участник приватного → `NONE` (→ 404); роль `guest` → всегда `NONE`;
   Then результат соответствует таблице §5 `permission-model.md` (проверяется табличным тестом на
   все 13 строк).

7. **Владелец обходит ACL, кроме vault.**
   Given `owner` и `ResourceAcl(PROJECT, USER=owner, NONE)`;
   When резолвится уровень на задаче этого проекта;
   Then `MANAGER` — обход не выполняется; для `resourceType ∈ {VAULT, VAULT_ITEM}` авторитет —
   `VaultMembership`, и `resolveAcl` к `ResourceAcl` не обращается вовсе.

8. **Один запрос, а не N.**
   Given документ на глубине 4 (DocPage → parent → Project → Organization);
   When резолвится уровень;
   Then выполняется **один** SQL-запрос (`WITH chain(...) VALUES ... JOIN resource_acl ... ORDER BY
   depth LIMIT 1`), цепочка предков строится разбором `path` (materialized path); тест считает
   число SQL-запросов на эндпоинт.

9. **Негативный сценарий — оборванная иерархия.**
   Given `DocPage.parentPageId` указывает на удалённую страницу;
   When резолвится уровень;
   Then `ancestorChain` возвращает `null` → `accessReader` отдаёт `null` → **404** + `logger.warn`
   с `resourceId`; «разрешить по организации» не происходит никогда.

10. **Негативный сценарий — ошибка резолва.**
    Given БД недоступна во время резолва ACL;
    When выполняется `can()` для права с `requiredLevel ≠ null`;
    Then DENY с `reason = acl_resolution_failed` и HTTP **503**; «не смогли проверить» ≠ «разрешено».

11. **Негативный сценарий — выдача доступа шире собственного.**
    Given руководитель с уровнем `EDITOR` на проекте;
    When он выдаёт кому-то `MANAGER` на этот проект;
    Then 403 — `acl:grant` требует `MANAGER` на ресурсе, выдать уровень выше собственного нельзя.

12. **Списки не резолвят построчно.**
    Given список из 200 задач;
    When он строится;
    Then множество доступных родителей вычисляется **один раз** и подставляется в
    `WHERE project_id = ANY($accessible)` с вычитанием поддеревьев `NONE`; интеграционный тест
    «список = фильтр по `can()` построчно» на малом наборе данных проходит.

13. **Удаление роли снимает её записи ACL** (перенесено из STORY-011-03).
    Given кастомная роль `tech_writer` с записью `ResourceAcl (subjectType = ROLE, subjectId = роль)`
    на проекте;
    When роль удаляется через `DELETE /api/v1/roles/{roleId}`;
    Then в той же транзакции исчезают и записи ACL этой роли, и `permissions_version`
    инкрементится всем, кто получал доступ через них. Осиротевшая запись ACL, ссылающаяся на
    несуществующую роль, — это доступ, который никто не может ни увидеть, ни отозвать из интерфейса.
    В 011-03 требование выполнить было нечем: таблицы ACL не существовало ни у одного домена.

## Задачи

- [x] `packages/server/prisma/migrations/20260906135729_resource_acl/migration.sql` — таблица
      `resource_acl`, enum'ы `acl_resource_type` (все двенадцать значений — расхождение №5 §12),
      `acl_subject_type` (`USER | ROLE | TEAM`), `access_level`; `uq_resource_acl` (пять колонок,
      он же индекс резолвера), `idx_resource_acl_subject`, `idx_resource_acl_expires`; RLS
      `ENABLE` + `FORCE` + обе политики, `GRANT`, `backup_role`, `updated_at`-триггер. Запись в
      `tenant-tables.constant.ts` и `ROW_FACTORIES`; генерируемый `rls-isolation.test.ts` покрывает
      таблицу с положительным контролем на `INSERT`. **Порядок колонок индексов отличается от
      §«Индексы» `data-model.md` в редакции до 2026-09-06** — см. «Сделано», п. 1.
- [x] `domain/access/acl-resolution.policy.ts` — `resolveFromChain(entries, implicit, now)`,
      правила 1–4, без I/O, 100/100 (имя — `.policy.ts`, потому что маска порога
      `src/domain/**/access/*.policy.ts` и словарь суффиксов не знают `acl-resolution.ts`).
- [x] `domain/access/implicit-level.policy.ts` — таблица §5: девять строк с предметом, шесть без
      предмета — не заведены (см. «Сделано», п. 3).
- [x] `application/access/ports/acl-reader.port.ts` + `persistence/prisma/acl-reader.adapter.ts` —
      один round-trip; SQL живёт в адаптере (Prisma `$queryRaw` с `Prisma.join` по узлам), не в
      отдельном `.sql`-файле: у проекта нет загрузчика файлов SQL, а строка в адаптере проверяется
      тем же рекордером, что и остальные.
- [x] Построение цепочки — **реестр** в `application/access/use-cases/resolve-acl.query.ts`
      (`ORGANIZATION`, `PROJECT → ORGANIZATION`), а не отдельный `ancestor-chain.service.ts`:
      суффикса `.service.ts` в словаре нет, и цепочек сегодня две. Тип без записи в реестре →
      `unavailable` (503), не уровень.
- [x] `application/access/use-cases/grant-acl.use-case.ts`, `revoke-acl.use-case.ts`; инкремент
      версий по субъекту — `AclRepositoryPort.subjectUserIds` + один `UPDATE … = ANY($n::uuid[])`.
- [x] Маршруты (2026-09-26): `GET /api/v1/acl?resourceType=&resourceId=` (`acl:read`,
      `ListResourceAclQuery`), `POST /api/v1/acl` (`acl:grant`, `GrantAclUseCase`, `Idempotency-Key`),
      `DELETE /api/v1/acl/{aclId}` (`acl:revoke`, `RevokeAclUseCase`) — `route-registry.factory.ts`,
      `acl.controller.ts`, `acl.validator.ts`, `acl.serializer.ts`; спека и `api-schema.d.ts`;
      снапшот матрицы (+42 ячейки); описания прав EN/RU, строка `acl` из `AWAITING_A_ROUTE` снята;
      сборка в контейнере — `buildAccess`, резолвер один на контейнер (поднят из `buildProject`).
- [x] Тесты: `test/unit/domain/access/{acl-resolution-policy,implicit-level-policy,acl-management-policy,acl-error-resource}.test.ts`,
      `test/unit/application/{resolve-acl.query,grant-acl.use-case,revoke-acl.use-case}.test.ts`,
      `test/unit/persistence/{acl-reader,resource-acl-repository,project-access-reader}.test.ts`,
      интеграционный `test/integration/db/resource-acl-reader.test.ts` (счётчик SQL из лога
      драйвера, `EXPLAIN` на 20 000 строк, изоляция, `TEAM`/`ROLE`-субъекты, факты проекта против
      таблиц EPIC-014). Согласованность списка (п. 12) — `test/integration/db/project-list.test.ts`
      (2026-09-26, STORY-014-04).
- [x] Тесты маршрутов (2026-09-26): `test/integration/http/acl-endpoints.test.ts`,
      `test/unit/application/list-resource-acl.query.test.ts`,
      `test/unit/domain/access/acl-contour-policy.test.ts`, `test/unit/http/acl-serializer.test.ts`,
      `test/contract/acl-resource-types.test.ts`; `findById`/`listOn` — рекордер и живой Postgres
      (`resource-acl-reader.test.ts`); в `openapi.test.ts` — сверка ключа `x-permission` с реестром.

## Сделано (2026-09-06) — таблица, правило, резолвер, команды; без маршрута

*Таблица ниже обновлена 2026-09-26: маршруты `/acl` и каскад при удалении роли и команды
отгружены, заголовок раздела описывает состояние на 2026-09-06.*

Критерии приёмки по факту кода, не по борду:

| # | Критерий | Состояние |
|---|---|---|
| 1 | выдача записи: `ResourceAcl`, бамп всем членам команды, `acl.granted` `WARNING` | закрыт: use-case (`grant-acl.use-case.test.ts`) и `POST /api/v1/acl` (`acl-endpoints.test.ts`, грант команде бампает обоих участников) |
| 2 | ближайшая явная запись побеждает | закрыт (`acl-resolution-policy.test.ts`; на живом Postgres — порядок по глубине в `resource-acl-reader.test.ts`) |
| 3 | `NONE` — явный запрет на узле и ниже | правило закрыто; **код ответа расходится**: история говорит 404, а `access.errors.ts` (STORY-011-07, прошёл гейты) отвечает `acl_explicit_none` как **403** `${resource}_forbidden`, и `assert-allowed.test.ts` это закрепляет. Не правил молча — решение за человеком: либо история приводится к коду (внутри своей организации 403 не оракул), либо `CODE_FOR` и тест меняются отдельным коммитом. На маршрутах `/acl` для объекта `PROJECT` `NONE` отвечается 404 (`acl-contour.policy.ts` повторяет `closeTheContour` проекта), иначе `/acl` был бы оракулом `PRIVATE`-проекта; `access.errors.ts` не тронут |
| 4 | максимум на одном узле | закрыт (домен + интеграция: `TEAM=EDITOR` и `USER=VIEWER` на одном узле) |
| 5 | просроченные не учитываются | закрыт дважды — фильтр `expires_at > now()` в SQL (не индексом: `expires_at` в индексе join'а нет, просроченные строки объекта читаются и отбрасываются фильтром, их единицы на объект) и правило в policy с `ClockPort` |
| 6 | `implicitLevel` вместо «разрешено всем» | закрыт для девяти строк §5 с предметом; шесть строк (`CHANNEL` ×4, личный ресурс ×2) — без предмета, перечислены по имени в тесте, заглушек нет. **Строк в таблице пятнадцать, а не тринадцать**, как написано в критерии |
| 7 | владелец обходит ACL, кроме vault | закрыт **не здесь**: обход живёт в `authorizeResource` (STORY-011-07), резолвер владельца не трогает, `family` для `VAULT` — `vault` (`ACL_RESOURCE_FAMILY`). Vault-ветки в реестре цепочек нет, тип отвечает `unavailable` |
| 8 | один запрос, а не N | закрыт: счётчик из лога драйвера на цепочке в четыре узла; `EXPLAIN` держит `Index Scan using uq_resource_acl` |
| 9 | оборванная иерархия → 404 + `logger.warn` с id | закрыт (`resolve-acl.query.test.ts`: `missing`, ридер не вызывается, `warn` с `resourceType`/`resourceId`) |
| 10 | ошибка резолва → `acl_resolution_failed`, 503 | закрыт (`unavailable` из резолвера → `service_unavailable`) |
| 11 | выдача шире собственного уровня → 403 | закрыт и на маршруте (`MEMBER` → `EDITOR` → 403 `insufficient_acl_level`), конъюнкцией `authorize` (`insufficient_acl_level` для `EDITOR` на объекте); отдельной ветки в `canGrantAcl` нет — `acl:grant` требует `MANAGER`, верх шкалы, шире которого выдать нечего, и тест-пин на `requiredLevel` в `acl-management-policy.test.ts` держит это на случай правки каталога. Единственная своя ветка `canGrantAcl` — `self_lockout` |
| 12 | списки не резолвят построчно | **закрыт 2026-09-26 на списке проектов** (STORY-014-04): узел организации читается один раз, узел проекта — одним `GROUP BY` по `resource_acl` внутри того же оператора, что строит страницу; «список = построчный `can()`» на живом Postgres — `test/integration/db/project-list.test.ts`. Списков задач нет — для них критерий повторится с их цепочкой |
| 13 | удаление роли снимает её записи ACL | **закрыт 2026-09-26**: `delete-custom-role.use-case.ts` в той же транзакции зовёт `AclRepositoryPort.removeAllOfSubject` (один `DELETE … RETURNING` по `idx_resource_acl_subject`) и пишет `acl.revoked` на каждую снятую запись с `after.cause = 'role.deleted'`; версию носителям уже бампает `bumpHoldersOf` до удаления назначений. Юнит — `custom-role.use-cases.test.ts`, живой Postgres — `test/integration/db/acl-subject-cascade.test.ts` (чужая организация с тем же uuid субъекта не задета) |

Что ещё решено по ходу и почему:

1. **Индексы ведут uuid-колонкой, а не enum'ом.** `enum_eq` не leakproof; под `FORCE RLS` для
   `app_user` равенство по enum никогда не становится `Index Cond`. Замер на 20 000 строк:
   `(organization_id, resource_type, resource_id)` — seq scan, 347 буферов, 2,2 мс;
   `(organization_id, resource_id, resource_type)` — index scan, 11 буферов, 0,17 мс. Владелец
   таблицы тем же запросом получал index scan, поэтому на dev-подключении это невидимо.
   `data-model.md` (индексы), `rls-design.md` (ловушка 6) и `rules/polymorphic-access.mdc` (п. 9)
   переписаны по замеру. Enum как тип колонки сохранён — правило 2 `polymorphic-access.mdc`.
   По итогу ревью индекс ресурса **слит с уникальным**: `uq_resource_acl (organization_id,
   resource_id, resource_type, subject_id, subject_type)` держит и уникальность, и резолвер;
   `organization_id` в ключе снимает 409 по совпавшей паре uuid чужой организации (находка
   security-auditor L-2). `granted_by_id` — `ON DELETE SET NULL ("granted_by_id")` в форме со
   списком колонок: голый `SET NULL` обнулял бы и `organization_id` и падал на NOT NULL
   (находка db-reviewer, замер). **Тот же дефект у закоммиченных `fk_user_roles_granted_by_id` и
   `fk_upo_granted_by_id`** — им нужна repair-миграция, отдельная задача.
2. **`ROLE` как субъект сохранён** вопреки постановке «USER и TEAM»: `data-model.md` и §2
   `permission-model.md` называют три субъекта, критерий 13 написан против `ROLE`, а enum в
   PostgreSQL расширяется дорого. Резолвер сопоставляет роли через `user_roles` с учётом
   `expires_at` в том же запросе.
3. **Шесть строк §5 без предмета не заведены.** `ImplicitLevelFacts` — union из двух членов
   (`ORGANIZATION`, `PROJECT`); добавление `CHANNEL` без ветки не компилируется. Не `it.todo`:
   обещание принадлежит эпику, который заведёт канал.
4. **Правило разрешения — в домене, не в SQL.** Запрос отдаёт все живые строки цепочки с
   глубиной; `GROUP BY … LIMIT 1` из эскиза §6 не используется, чтобы правило жило в одном месте
   с табличным тестом. `permission-model.md` §6 дополнен абзацем об этом.
5. **`acl.updated` не заведён**: замена уровня — тот же `acl.granted` с `before`. `AUDIT_ACTIONS`
   расширен двумя действиями, `AUDIT_RESOURCE_TYPES` — `RESOURCE_ACL`.
6. **Ошибки без нового ресурса `acl`.** Отказ на объекте кодируется ресурсом объекта
   (`project_forbidden`/`project_not_found`), отсутствие субъекта — ресурсом субъекта
   (`team_not_found`): новый код в `ERROR_RESOURCES` потребовал бы правки `openapi.yaml` и обоих
   файлов локалей — это шаг маршрута. Полная карта — `domain/access/acl-error-resource.util.ts`.
7. **`guest` читается из `actor.roleKeys`** — единственное санкционированное чтение ролей
   policy (§5, последняя строка; `IMPLICIT_LEVEL_NONE_ROLES`). Докстринг `actor.types.ts` уточнён.
8. **`ProjectAccessReaderPort` лежит в `application/access/ports/`**, а не в `project/`: контекст
   проекта создавался параллельно этим шагом. Сворачивать его в порт под `project/` не стали
   (2026-09-06, третий шаг EPIC-014): единственный потребитель — резолвер, policy проекта читает
   `scope()` репозитория и `AclScope`; докстринг порта говорит то же.
   Адаптер — raw SQL по именам `data-model.md` §3; имена доказаны интеграционным тестом против
   миграции `20260906135656_projects_and_project_members`.

## Сделано (2026-09-26) — маршруты `acl:*`

1. **`DELETE` адресуется id гранта**, поэтому `RevokeAclUseCase` читает строку сам: ключ → строка →
   объект → уровень (`canRevokeAcl` принимает scope thunk'ом, как `canReadProject`). Любой посторонний —
   один `404 acl_not_found` (новый ресурс `acl` в `ERROR_RESOURCES`, спеке и локалях): закодированный
   на объекте отказ различал бы «такого гранта нет» и «грант на невидимом проекте».
2. **`resourceType` на маршрутах — только разрешимые виды** (`ORGANIZATION`, `PROJECT`,
   `resolvable-acl-resource-types.constant.ts`, им же ключуется реестр цепочек резолвера): вид без
   цепочки — `422`, а не `503`.
3. **Список — только строки самого объекта, живые на момент `ClockPort`**, `{ items }` без пагинации
   (как состав проекта).
4. Побочно: middleware-отказ на ключе `acl:*` теперь `acl_forbidden`, а не `organization_forbidden`
   (`refusalResourceOf` берёт ресурс ключа, раз он есть в словаре ошибок).

Следующему шагу: критерий 12 при первом списке, решение по коду ответа для критерия 3,
перенос `ProjectRole`/`ProjectVisibility` из `implicit-level.policy.ts` на `domain/project/project.enums.ts`
(файл того же дня, ещё не в истории на момент этого коммита).

## Ссылки

- [`permission-model.md` §2 «Слой 4 — resource-scoped ACL»](../../../docs/security/permission-model.md)
- [`permission-model.md` §5 `implicitLevel`, краевые случаи 3, 6, 7, 9, 12](../../../docs/security/permission-model.md)
- [`permission-model.md` §6 «Наследование ACL», «Как это выполняется в БД», «Списки»](../../../docs/security/permission-model.md)
- [`permission-model.md` §12, расхождение №5](../../../docs/security/permission-model.md)
- [`threat-model.md`, `T-TENANT-05`, `T-PROJ-01`](../../../docs/security/threat-model.md)

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
