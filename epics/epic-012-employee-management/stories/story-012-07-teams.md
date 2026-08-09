---
id: STORY-012-07
epic: EPIC-012
status: review
blocked: false
priority: should
estimate: M
---

# STORY-012-07 — Команды как субъект ACL

**Как** администратор системы (P5) **я хочу** объединять сотрудников в команды и выдавать доступ
сразу команде, **чтобы** при найме нового бэкендера не обходить двадцать проектов и папок вручную,
а при переводе человека доступ менялся вместе с его составом команд.

## Acceptance (Given/When/Then)

1. **CRUD команды.**
   Given администратор с `team:create`;
   When `POST /api/v1/teams` с `{ name, slug, description }` (без `leadId` — см. «Расхождение с этой спекой»);
   Then создаётся `Team`; `slug` уникален внутри организации; в `AuditLog` — `team.created`.

2. **Управление составом.**
   Given команда и сотрудник;
   When `POST /api/v1/teams/{teamId}/members` (право `team:manage_members`);
   Then создаётся `TeamMember(teamRole = MEMBER|LEAD)`, инкрементится `permissions_version`
   **этого пользователя** в той же транзакции; `uq_team_members (team_id, user_id)` не допускает
   дублей.

3. **Команда — субъект ACL.**
   Given `ResourceAcl(PROJECT, USER=none, subjectType = TEAM, subjectId = backend, EDITOR)`;
   When Иван добавляется в команду backend;
   Then он немедленно (после инвалидации версии) получает уровень `EDITOR` на этот проект без
   создания персональной записи ACL.

4. **Выход из команды отбирает доступ.**
   Given Иван в команде backend с доступом через ACL команды;
   When он удаляется из команды;
   Then `permissions_version` инкрементится, `resolveAcl` перестаёт учитывать эту запись (субъект
   больше не совпадает), доступ пропадает на следующем запросе; проверяется интеграционным тестом
   «удаление из команды закрывает проект».

5. **Удаление команды.**
   Given команда с 5 участниками и 3 записями `ResourceAcl`;
   When `DELETE /api/v1/teams/{teamId}`;
   Then в одной транзакции удаляются `TeamMember` и все `ResourceAcl` с
   `subjectType = TEAM, subjectId = teamId`, версия инкрементится всем бывшим участникам одним
   `UPDATE`; в `AuditLog` — `team.deleted` + `acl.revoked` по каждой снятой записи.

6. **Максимум на одном узле.**
   Given на проекте есть `TEAM=backend → EDITOR` и `USER=ivan → VIEWER`, Иван в backend;
   When резолвится уровень;
   Then `EDITOR` (максимум на одном узле); понизить конкретного человека можно только `NONE` или
   записью на более близком узле.

7. **Негативный сценарий — команда чужой организации.**
   Given `teamId` из организации B;
   When администратор организации A добавляет туда участника;
   Then **404** `resource_not_found`.

8. **Негативный сценарий — нет права.**
   Given пользователь без `team:manage_members`;
   When он меняет состав;
   Then 403 `permission_not_granted`; кнопка в UI отсутствует (гарды через `<Can>`).

9. **Негативный сценарий — деактивированный участник.**
   Given сотрудник деактивирован;
   When он числится в команде;
   Then он не даёт доступа: сборка `Actor` невозможна для `SUSPENDED`, а офбординг удаляет
   `TeamMember` (см. [STORY-012-05](story-012-05-offboarding.md)).

10. **Команда — не группа доступа.**
    Given документация и UI;
    When пользователь читает подсказку;
    Then явно сказано, что `Team` — оргструктурная сущность; отдельные группы доступа
    (`subjectType = GROUP`) — открытый вопрос №3 §12 `permission-model.md` и в M2 не вводятся.

## Задачи

- [x] ~~Миграция~~ — не потребовалась. `teams` и `team_members` существуют с RLS (`ENABLE` + `FORCE`,
      оба предиката, `GRANT`), `uq_team_members`, `idx_team_members_org_user` и **уже существующий**
      `uq_teams_org_slug (organization_id, slug) WHERE deleted_at IS NULL` на месте. Колонка
      `lead_id` не добавлена сознательно — см. «Расхождение с этой спекой». Добавлен только
      недостающий комментарий о частичном индексе в `prisma/schema.prisma`.
- [x] `packages/server/src/application/iam/use-cases/write-team.use-case.ts`
      (`CreateTeamUseCase` + `UpdateTeamUseCase`), `delete-team.use-case.ts`,
      `manage-team-members.use-case.ts` (`AddTeamMemberUseCase` + `RemoveTeamMemberUseCase`).
- [x] `packages/server/src/application/iam/use-cases/list-teams.query.ts`,
      `get-team-detail.query.ts` — состав команды. Числа записей ACL нет: таблицы нет.
- [x] `packages/server/src/domain/iam/access/team-access.policy.ts` + порт
      `application/iam/ports/team-repository.port.ts` и `infrastructure/persistence/prisma/team.repository.ts`.
- [x] Инкремент `permissionsVersion` — `bumpPermissionsVersionOf(userIds)`,
      `UPDATE ... WHERE id = ANY($n::uuid[])`, один оператор и на изменение состава, и на удаление
      команды; цикла в приложении нет.
- [x] `packages/server/src/presentation/http/route-registry.factory.ts` — семь маршрутов на
      `team:read/create/update/delete/manage_members`, у каждого `aclCheckedIn`;
      `docs/api/openapi.yaml` и снапшот матрицы прав обновлены.
- [x] `packages/client/src/units/team/{model,service,ui}` + `widgets/team-list/team-list.widget.tsx`,
      `widgets/team-detail/team-detail.widget.tsx` — клиентская часть, отдельная работа.
- [x] Тесты: `test/unit/domain/access/team-access-policy.test.ts` (37),
      `test/integration/http/team-endpoints.test.ts` (43),
      `test/integration/db/team-repository.test.ts` (24, живой Postgres).
      `team-acl-propagation` и `delete-team-cascades-acl` не написаны: проверять нечего до
      STORY-011-06. Isolation-тесты `teams` и `team_members` уже существуют — обе таблицы в
      `TENANT_TABLES`, генерируемый `rls-isolation.test.ts` покрывает их с положительным контролем.

## Ссылки

- [`permission-model.md` §2 «Слой 4», субъекты `USER | ROLE | TEAM`](../../../docs/security/permission-model.md)
- [`permission-model.md` §5, краевой случай 12; §8 «Что инкрементит permissionsVersion»](../../../docs/security/permission-model.md)
- [`permission-model.md` §12, открытый вопрос №3 (группы вместо команд)](../../../docs/security/permission-model.md)
- [`data-model.md`, группа 1, `Team`, `TeamMember`](../../../docs/architecture/data-model.md)
- [`permission-model.md` §3.1 (`team:*`)](../../../docs/security/permission-model.md)

## Сделано (2026-08-08) — серверная часть

Закрыты критерии **1, 2, 5, 7, 8, 9, 10**. Критерии **3, 4 и 6 сознательно не реализованы**: все три
описывают команду как субъект `ResourceAcl`, а ни таблицы `resource_acls`, ни функции `resolveAcl` в
продукте нет — это [STORY-011-06](../../epic-011-rbac-permissions/stories/story-011-06-resource-acl.md),
помеченная `blocked: true`. Заглушка вместо них — код отказа, который никто не может вызвать, или
поле, которое никогда не меняется, — была бы обещанием без теста за ним. Критерий 5 закрыт **без**
каскада по `ResourceAcl` по той же причине; всё остальное в нём (мягкое удаление команды, удаление
всех `TeamMember`, один `UPDATE` на инкремент версий, запись `team.deleted`) сделано.

### Миграции не потребовалось, и это главная находка

Задача предполагала миграцию на уникальный slug внутри организации. Она уже есть — с самой первой
миграции: `uq_teams_org_slug (organization_id, slug) WHERE deleted_at IS NULL`
(`20260727120000_init_tenancy_and_rls`). Частичный индекс, поэтому Prisma его не выражает и в
`schema.prisma` его нет; в проекте это оформленное соглашение (так же живут `uq_users_org_email`,
`idx_roles_org_default` и ещё пять), но у модели `Team` не хватало комментария, объясняющего пропуск.
Комментарий добавлен. Второй такой же индекс был бы дефектом, а не подстраховкой.

Проверено по факту и на живом Postgres: у `teams` и `team_members` есть `ENABLE` **и** `FORCE ROW
LEVEL SECURITY`, каноническая политика с обоими предикатами на роль `app_user`, maintenance-политика
и явные `GRANT` (включая `backup_role`). Обе таблицы уже зарегистрированы в `TENANT_TABLES` и
`ROW_FACTORIES`, поэтому генерируемый `rls-isolation.test.ts` покрывает их вместе с положительными
контролями. Блокирующих дефектов не найдено — чинить было нечего.

### Расхождение с этой спекой: `leadId` — не колонка, а членство

Критерий 1 просит `POST /api/v1/teams` с полем `leadId`, и `data-model.md` §1 тоже называет
`Team.leadId`. В `prisma/schema.prisma` такой колонки нет, а роль лида выражена через
`team_members.team_role = 'LEAD'` с ограничением `ck_team_members_role` — так с момента создания
таблицы членств (STORY-012-02). Выбрана существующая модель, колонка **не** добавлена.

Причина не в экономии миграции. Две модели одного факта расходятся при первой же записи мимо одной из
них: колонка говорит, что команду ведёт Иван, а строки членства — что он в ней не состоит, и нет
правила, по которому видно, какая из двух врёт. Удаление участника пришлось бы отдельно помнить
обнулять в колонке; офбординг, который удаляет `team_members`, оставил бы `lead_id` указывать на
уволенного. Лид назначается через `POST /teams/{teamId}/members` с `teamRole: 'LEAD'`; `leadId` в теле
запроса отвергается схемой (`strictObject`), и на это есть тест.

Устаревшее утверждение снято заодно: докстринг модели `Team` всё ещё сообщал, что «`Organization.ownerId`
и `Team.leadId` пока отсутствуют и придут в STORY-006-01». Первое приехало ещё в EPIC-006, второе не
приедет никогда.

### Что решено по ходу

**Проверка права идёт до чтения строки.** Во всех use-case сначала `assertAllowed(canXTeam(actor))`,
и только потом репозиторий. Так «у вас нет права» и «такой команды нет» стоят одинаковое время
(`permission-model.md` §5), и запрос не уходит в БД от того, кто спрашивать не вправе.

**Мягко удалённая команда неотличима от несуществующей.** `teams.deleted_at` ставится, строка
остаётся видимой репозиторию — поэтому `scope`/`detail` возвращают её с флагом, а решение принимает
политика и отвечает `404 team_not_found`. Список — единственное чтение, которое фильтрует, и
фильтрует в SQL.

**Деактивированного нельзя добавить в команду** (`409 member_not_active`, как у передачи владения).
Офбординг удаляет членства именно затем, чтобы деактивированный не числился нигде; путь добавления,
принимающий `SUSPENDED`, отменял бы это по строке за раз.

**`permissionsVersion` инкрементится, хотя сегодня членство ничего не даёт.** Это не декорация:
версия — механизм, по которому свёрнутое представление перестаёт быть доверенным, и версия, которая
начала бы двигаться только в релизе с ACL, оставила бы все токены, выпущенные до него, доверяющими уже
отозванному членству.

## Гейт безопасности закрыт (2026-08-09)

Гейт STORY-012-07 дал PASS с находками M-2 (главная), M-1, L-3, L-1/L-2. Все закрыты, кроме одной,
принятой как остаточный риск.

**M-2 — `team.deleted` теперь пишет полный состав, а не число.** `disband()` (`team.repository.ts`)
возвращает `{ userId, teamRole }[]` вместо списка одних `userId` (`DELETE … RETURNING user_id,
team_role`); `delete-team.use-case.ts` пишет в `before.members` этот список. Прецедент из того же
эпика (`deactivate-user.use-case.ts`, `after.teams`) оказался решающим доводом: счётчик у
`team.deleted` был асимметричен по отношению к нему без причины, которая пережила бы сверку. Довод
«состав команды не должно быть в трейле, хранимом годами» снят — там же хранится состав команд
уволенного сотрудника. Докстринг `audit-action.enums.ts` поправлен (обещал `after`, код писал
`before`). Заодно закрыта смежная находка коллеги-гейта: `team.deleted` теперь `WARNING`, а не
`INFO`, пин на это добавлен в `team-endpoints.test.ts`.

Дыра приглашений, упомянутая гейтом отдельно (`invitation.accepted` писал число вместо `teamIds`),
оказалась дешёвой и закрыта тем же приёмом: `InvitationRepositoryPort.joinTeams` теперь возвращает
`readonly string[]` (`RETURNING team_id`), `accept-invitation.use-case.ts` пишет `after.teamIds`.
`team.member_added` никогда не пишется для членства, созданного принятием приглашения, — так что до
этой правки `invitation.accepted` было единственное место, где могли бы жить эти id, и оно их не
писало. Не отдельная история — один и тот же приём, тот же PR.

**M-1 — TOCTOU между членством и офбордингом/роспуском закрыт блокировками строк.** `scope()` и
`subject()` (`team.repository.ts`) читают `SELECT … FOR SHARE` вместо `Prisma.findFirst`. Гонка
закреплена тестом на живом Postgres с двумя параллельными транзакциями
(`test/integration/db/team-membership-race.test.ts`, по образцу
`test/integration/db/ownership-transfer.test.ts:199-231`): без блокировок тест ловил `SUSPENDED`-
аккаунт с живым членством и членство на расформированной команде в 11 из 12 прогонов; с блокировками
— 0 из ~20 прогонов инвариант не нарушен ни разу.

**L-3 — смена роли участника больше не молчит.** `addMember()` — теперь `SELECT … FOR UPDATE`, потом
`INSERT … ON CONFLICT (team_id, user_id) DO UPDATE SET team_role = EXCLUDED.team_role WHERE
team_members.team_role <> EXCLUDED.team_role`, а не `DO NOTHING`. Порт возвращает
`{ outcome: 'created' | 'role_changed' | 'unchanged', previousRole }`; use-case пишет
`team.member_role_changed` (новое действие каталога, `INFO`, тот же уровень, что у add/remove) для
`role_changed`, `team.member_added` — только для настоящего первого вступления. Выбран апдейт, а не
явный 409, потому что назначение лида **и так** идёт через этот же `POST` — отдельного эндпоинта нет
(см. «Расхождение с этой спекой» выше), значит `DO NOTHING` не «защищал от неоднозначности», а делал
единственный способ назначить лида нерабочим.

**L-1 — смягчено: `member_not_active` требует `user:read`.** `assertMemberJoinable`
(`team-access.policy.ts`) принимает актора и, если тот не держит `user:read`, отвечает тем же `404
user_not_found`, что и для аккаунта чужой организации, вместо информативного `409
member_not_active`. Держатель `user:read` видит прежний 409 без изменений.

### Что отложено

**L-2 — принят как остаточный риск, не смягчён; обоснование переписано 2026-08-09.** `DELETE
/teams/{teamId}/members/{userId}` по-прежнему различает `204`/`404` при одном `team:manage_members`.
Первая версия этого пункта утверждала, что «каждая попытка» разрушительна и оставляет
`team.member_removed`/`team.member_added` в `AuditLog» — неверно для промаха. По коду
(`manage-team-members.use-case.ts`, `RemoveTeamMemberUseCase.execute`) проверка `if (!removed) throw
denyAccess(...)` стоит **до** `audit.record`: промах (`404 user_not_found`, `userId` не в этой
команде) не трогает `team_members`, не бампает версию и не пишет в `AuditLog` — закреплено тестом
`team-endpoints.test.ts` («answers 404 when the person is on no such team»), где `versionBumps`
пуст и события `team.member_removed` отсутствуют. Только попадание (`204`, реальное снятие
членства) стоит чего-то и оставляет след.

Решение не изменилось (риск принят, не `team:read`), изменилось почему: бесплатный канал
(промахи) отдаёт лишь отрицательную информацию, причём тем же кодом `user_not_found`, которым
отвечает и «такого `userId` нет в организации вовсе» — `denyAccess('user', 'other_organization')`
не различает эти случаи по определению, так что проба сама по себе не подтверждает даже
существование аккаунта. Чтобы получить положительный факт («этот `userId` реально в команде»),
нужно дойти до попадания — по-прежнему разрушительного и аудируемого действия с ценой (повторный
`POST`, чтобы вернуть как было) и со следом (`team.member_removed` без предшествующего
`team.member_added` той же пары — сигнал, обнаружимый при ревью аудита, как и было заявлено, но
для правильной, дорогой ветки, а не для бесплатной). Добавление `team:read` как второго требуемого
права на этот маршрут остаётся самостоятельным решением о форме права, которое должно пройти как
явно рассмотренное расширение прав (`rules/permissions.mdc`, п. 14), а не попутная правка внутри
этого гейта; писать в `AuditLog` и на промах отклонено отдельно — каталог действий
(`audit-action.enums.ts`) сознательно ограничен тем, что произошло, а не тем, что было
предпринято, и первая запись такого рода — решение того же уровня, что расширение прав.
Зафиксировано в `docs/security/threat-model.md`, `RR-09` и `T-IAM-11`.

**429 без лимитера на всех семи маршрутах команд.** `GET/POST /teams`, `GET/PATCH/DELETE
/teams/{teamId}`, `POST/DELETE /teams/{teamId}/members` документируют `429` с обязательным
`Retry-After` (`docs/api/openapi.yaml`, `#/components/responses/RateLimited` на каждой операции),
но ни один из семи маршрутов не подключён ни к одному лимитеру: `RATE_LIMIT_POLICY.api_request`
(300/мин) вызывается только из `refresh-session.use-case.ts` и
`confirm-password-reset.use-case.ts`, глобальной middleware, применяющей его ко всем маршрутам,
нет. Это не регресс этой истории — та же необеспеченная `429` уже документирована примерно на 39
операциях контракта, — но семь новых обещаний добавлены этой дельтой, и они не выполняются со дня
мержа. Причина не чинить здесь: полный набор rate limits и ревизия «каждый путь имеет лимит» —
явный пункт скоупа [EPIC-045](../../epic-045-security-hardening/epic.md) («Финальное укрепление
безопасности», M9), а не точечная правка внутри доменной истории M2. Владеющий этап — EPIC-045.

**`ipAddress: undefined` в записях аудита команд.** Оба use-case (`AddTeamMemberUseCase`,
`RemoveTeamMemberUseCase`) пишут `actor.ipAddress: undefined` в `AuditLog` — паттерн, действующий
по всему серверу (26 вхождений на сегодня), не специфичный для этой истории. `AuditLoggerPort`
сегодня заготовка (STORY-009-06); реальный IP из запроса начнёт доходить до актора аудита, когда
[EPIC-016](../../epic-016-audit-log/epic.md) («Журнал действий», M2) построит настоящий журнал —
[NFR-6](../../../docs/product/prd.md#nfr-6-безопасность) явно требует IP в каждой записи. Владеющий
этап — EPIC-016.

**L-3, остаточный риск: дублирующий исход при одновременном первом вступлении.** Два параллельных
`addMember` для **ещё не существующей** пары `(teamId, userId)` не берут блокировку друг у друга —
`SELECT … FOR UPDATE` не запирает то, чего ещё нет. Данные не портятся: `INSERT … ON CONFLICT`
PostgreSQL сам сериализует и оставляет ровно одну строку. Портится классификация — обе транзакции
читают пустой `existing` до того, как первая из них зафиксировалась, и обе поэтому докладывают
`outcome: 'created'` из **своего** снимка, а не из фактического результата своей же вставки; на
это купился `manage-team-members.use-case.ts`, который аудирует и бампает версию по значению
`outcome`. Итог реальной гонки — одно фактическое членство, но два `team.member_added` и два
бампа `permissionsVersion` для одного человека. Помечено судьёй как Low. Не исправлено сейчас:
корректный фикс требует переносить классификацию `created`/`role_changed`/`unchanged` в саму
атомарную операцию (`RETURNING (xmax = 0)` вместо предварительного `SELECT`), пересматривать, как
`previousRole` попадает в `before` записи `role_changed`, и — по прецеденту M-1
(`test/integration/db/team-membership-race.test.ts`) — доказывать это отдельным тестом с двумя
параллельными транзакциями на живом Postgres, а не юнитом с рекордером. Это отдельная по объёму
правка того же метода, который в этой же волне уже прошёл фиксы L-3 и WHERE-предиката, и делать
её без гонки-теста означает менять проверенный код вслепую. Владеющий этап — следующее касание
`addMember`/`team.repository.ts` (нет отдельного эпика; отслеживается здесь до появления такого
касания или до STORY-011-06, где `addMember` в любом случае меняется под ресурсный ACL).

**Информационно.** `write-team.use-case.ts`: `UpdateTeamUseCase` читал `teams.detail()` (весь ростер)
ради `name`/`slug` в `before` на каждое переименование. Добавлен `TeamRepositoryPort.summary()` —
тот же `scope()`-подобный `SELECT`, но с `name`/`slug`, без `members`; use-case переключён на него.

## Definition of Done

- [x] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [x] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [x] Документация обновлена (docs/ + запись в `docs/brain/`)
- [x] a11y и i18n — axe по четырём состояниям, оба языка, `pnpm i18n:check` зелёный
- [x] **Isolation-тест RLS** — новых таблиц нет; `teams` и `team_members` уже в `TENANT_TABLES`, генерируемый набор покрывает их с положительным контролем
- [x] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
