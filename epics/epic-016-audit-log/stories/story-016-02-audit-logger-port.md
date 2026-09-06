---
id: STORY-016-02
epic: EPIC-016
status: in-progress
blocked: false
priority: must
estimate: L
---

# STORY-016-02 — AuditLoggerPort и запись событий из use-cases

**Как** администратор системы (P5) **я хочу**, чтобы каждое привилегированное действие оставляло
запись с актором, объектом, состоянием до и после и идентификатором запроса, **чтобы** на вопрос
«кто это сделал и что было раньше» отвечал журнал, а не реконструкция по косвенным признакам.

> **Статус поднят `backlog` → `in-progress` 2026-09-06, по сверке с кодом.** `backlog` означает «не
> начата», а из десяти критериев приёмки пять закрыты целиком (1, 3, 5, 6, 8), три закрыты
> наполовину (2 — недостают `acl.*` и `file.*`; 4 — нет outbox-половины; 9 — fail-closed работает,
> деградации `INFO` нет) и два открыты (7, 10). Собственный вклад истории отгружен более чем наполовину — врезка ниже («Что уже
> сделано — и **не этой историей**») это уже не покрывает, потому что писалась до трёх коммитов
> аудита:
>
> - **критерий 5 (секреты в `before`/`after`) закрыт — но не whitelist'ом, которого просила
>   история.** `4463e0d` завёл deny-list `application/platform/audit/audit-redaction.util.ts`,
>   который прогоняется на каждой записи, и корпус-тест
>   `test/unit/audit/audit-redaction-corpus.test.ts`, читающий вызовы из дерева. Обоснование отказа
>   от whitelist'а записано в докстринге самого файла (allow-list молча пустеет на забытом действии
>   и дрейфует от вызовов). Файла `audit-field-whitelist.ts` нет и не будет — задача в списке ниже
>   закрыта другим решением, а не осталась несделанной;
> - **критерий 8 (адрес) закрыт вместе с гейтом против регресса.** Гейт —
>   `test/contract/audit-privileged-ip-address.test.ts` плюс
>   `test/contract/support/audit-record-call.util.ts`: он выводит из severity действия и из текста
>   вызова, обязан ли этот вызов нести адрес, вместо списка имён руками;
> - **`session.refresh_reuse_detected` отгружен** — действие есть в
>   `packages/shared/src/audit/audit-action.enums.ts`, вызов в
>   `application/identity/use-cases/refresh-session.use-case.ts:178`, тест
>   `test/unit/application/refresh-session.use-case.test.ts:271`. Пункт 5 раздела «Что реально
>   открыто» описывает снятое состояние;
> - **отказ вместо деградации (`AuditTrailUnscopedError`, `AUDIT_ACTIONS_WITHOUT_ORGANIZATION`)** —
>   `7942a18`, плюс `test/unit/audit/audit-unscoped-guard.test.ts` и метрика
>   `audit_unscoped_total`.
>
> **Аудит отказов (критерий 7) закрыт 2026-09-06** — здесь он числился первым из открытых.
> Действия `access.denied` и `access.denial_burst` в каталоге, отбор —
> `packages/server/src/domain/access/denied-access-audit.policy.ts`, запись —
> `packages/server/src/application/access/use-cases/record-denied-access.use-case.ts`, вызов из
> общего обработчика ошибок со своим `withTenant`, агрегат серий — на бюджете
> `access_denial_audit` (11 записей на актора в минуту), а не на планировщике, которого в продукте
> действительно нет.
>
> Открытыми остаются три вещи и ни одна из них не про порт: деградация `INFO` при сбое записи
> (критерий 9), замер накладных расходов (критерий 10) и сквозной `requestId` через outbox
> (половина критерия 4 — outbox в коде нет, `find packages/server/src -iname '*outbox*'` печатает
> пусто). Плюс недостающие семейства критерия 2 — `acl.*` и `file.*`, — которые ждут EPIC-014 и
> EPIC-015, а не эту историю.
>
> Абзацы ниже оставлены как запись состояния на 2026-08-30, а не как утверждение о текущем;
> расхождения помечены построчно.

## Acceptance (Given/When/Then)

1. **Порт и запись в той же транзакции.**
   Given `AuditLoggerPort.record(event)` и use-case, меняющий состояние;
   When изменение выполняется;
   Then запись аудита пишется **в той же транзакции**; откат транзакции откатывает и запись, а
   падение после коммита не теряет событие (тест на оба сценария).

2. **Обязательный список событий покрыт.**
   Given реализованные к моменту истории домены;
   When проверяется `audit-coverage.spec.ts`;
   Then для каждого из перечисленных ниже действий существует запись с корректными `action`,
   `resourceType`, `severity`:
   - **права и роли:** `role.created/updated/deleted`, `role.assigned/revoked`,
     `permission.override.created/updated/deleted/expired`, `acl.granted/updated/revoked`,
     `permissions.recomputed`;
   - **владение и организация:** `organization.ownership_transferred` (`critical`),
     `organization.security_policy_updated`, `organization.settings_updated`;
   - **учётные записи:** `user.invited/accepted/suspended/reactivated`, `user.mfa_enabled/disabled`,
     `user.mfa_reset_by_admin` (`critical`), `user.mfa_recovery_code_used`,
     `user.impersonation_started/ended` (`critical`), `user.login`, `user.logout`,
     `session.revoked`, `session.refresh_reuse_detected` (`critical`);
   - **файлы:** `file.upload_presigned`, `file.committed`, `file.download_url_issued`,
     `file.deleted/restored/purged`, `file.acl_changed`;
   - **экспорт данных:** `audit.exported` (`critical`), `organization.data_exported` (`critical`),
     `report.exported`;
   - **секреты (задел под M7):** события домена vault и секретных ссылок регистрируются тем же
     портом, когда домены появятся.

3. **Наборы прав пишутся целиком.**
   Given изменение состава прав роли;
   When пишется событие;
   Then `before`/`after` содержат **полный** список ключей до и после, а не дельту; `reason`
   оверрайда обязателен и присутствует в `after`.

4. **Актор всегда известен.**
   Given действие пользователя, воркера или интеграции;
   When пишется событие;
   Then `actorType` заполнен (`USER | SYSTEM | API_KEY | INTEGRATION`), для системных действий
   `actorId = null`; `requestId` протянут сквозь HTTP → outbox → job → аудит (тест сквозного
   `requestId`, `T-PLAT-09`).

5. **Негативный сценарий — секреты в журнале.**
   Given событие с полями, содержащими пароль, токен, ключ, `totpSecretEnc`, presigned URL,
   расшифрованное содержимое;
   When оно записывается;
   Then эти поля отсутствуют: `before`/`after` строятся по **whitelist** полей на каждый тип
   события; тест `audit-redaction-corpus.spec.ts` прогоняет набор payload'ов и проверяет отсутствие
   паттернов секретов (`T-PLAT-06`).

6. **Негативный сценарий — актор из тела запроса.**
   Given тело запроса содержит `actorId`;
   When пишется событие;
   Then поле игнорируется: актор берётся из `AsyncLocalStorage`-контекста сессии (`T-TASK-04`).

7. **Отказы логируются выборочно.**
   Given отказы в доступе;
   When они происходят;
   Then пишутся: отказ по праву с `isDangerous` — всегда; отказ на изменяющем запросе
   (`POST/PATCH/DELETE`) — всегда; серия > 10 отказов за минуту от одного актора — одной
   агрегированной записью; отказы на `GET` — **только метрика** `permission_denied_total{reason}`.

   > **Сделано 2026-09-06.** Правило исполнено буквально, тремя фильтрами:
   > причина (`AUDITED_DENIAL_REASON` — тотальный `Record<DenyReason, string | null>`), класс
   > запроса (`recordableDenial`) и бюджет на актора (политика `access_denial_audit`, 11 записей в
   > минуту; одиннадцатая **и есть** агрегированная — `access.denial_burst`). Отказ на `GET` не
   > стоит даже обращения в Redis — а вот отказ на `GET` по **опасному** ключу пишется, и это не
   > исключение из правила, а его первый пункт.
   >
   > Четыре решения, принятые по ходу, и все они шире буквы критерия:
   >
   > - **`not_authenticated` не пишется вовсе.** У него нет ни субъекта, ни организации, а
   >   `audit_logs.organization_id` — `NOT NULL`. Расширение `AUDIT_ACTIONS_WITHOUT_ORGANIZATION`
   >   рассматривалось и отвергнуто: оно направило бы единственный неограничиваемый поток —
   >   неаутентифицированный — в канал журнала ради фразы «кто-то не вошёл».
   > - **Конфликты состояния (409) и `acl_resolution_failed` записями не становятся.** Первое —
   >   не отказ в доступе, второе — наш отказ, а не чужой.
   > - **`resource_not_found` и `tenant_mismatch` пишутся одним словом `not_found`** — иначе журнал
   >   стал бы оракулом существования чужих строк, которым не стал API (инвариант 2).
   > - **Запись стоит в общем обработчике ошибок, а не в `assertAllowed` и не в use-case'ах**, и
   >   открывает **свой** `withTenant` на актора отказа. Разбор альтернатив — в докстринге
   >   `record-denied-access.use-case.ts`; вопрос «где именно», который эта история носила
   >   открытым, решён там.
   >
   > Сбой записи отказа не роняет ответ и ничего не откатывает — откатывать нечего, отказ уже
   > состоялся; он считается в `audit_write_failed_total`. Это **не** нарушение критерия 9: тот
   > говорит про событие, которое произошло.
   >
   > Доказательства: `packages/server/test/unit/domain/access/denied-access-audit.policy.test.ts`,
   > `packages/server/test/unit/application/record-denied-access.use-case.test.ts`,
   > `packages/server/test/unit/http/denied-access-audit-wiring.test.ts` (там же положительные
   > контроли: успешный запрос, рядовой отказ на `GET` и не-отказ не пишут ничего).

8. **IP хешируется.**
   Given запись события;
   When сохраняется адрес;
   Then в колонке `ip_hash` — соль + хеш, а не сырой адрес; соль не попадает в дампы вместе с
   данными (ключ в env).

9. **Негативный сценарий — сбой записи аудита.**
   Given ошибка вставки в `audit_logs` для события безопасности;
   When она происходит;
   Then транзакция откатывается целиком — операция не считается выполненной (fail-closed для
   `severity ∈ {warning, critical}`); для `info`-событий допускается деградация с метрикой
   `audit_write_failed_total` и алертом.

10. **Производительность.**
    Given изменяющий запрос;
    When он выполняется;
    Then аудит добавляет одну вставку и не выполняет дополнительных чтений внутри транзакции;
    накладные расходы измерены и зафиксированы в нагрузочном сценарии.

## Задачи

Отметки проставлены 2026-09-06 по факту кода; там, где реализация разошлась с планом задачи, рядом
стоит, чем она закрыта.

- [x] `packages/server/src/application/platform/ports/audit-logger.port.ts` — есть (STORY-009-06).
      отдельный файл типов события в `packages/shared/src/audit/` не заведён: union «действие → обязательные
      поля» заменён закрытым списком `AUDIT_ACTIONS` + `AUDIT_ACTION_SEVERITY`
      (`Record<AuditAction, …>`, действие без уровня не компилируется).
- [x] Адаптер вставки в текущей транзакции — отгружен как
      `packages/server/src/infrastructure/persistence/prisma/audit-log.adapter.ts` (имя разошлось
      с планом); транзакция берётся из `withTenant` через AsyncLocalStorage, а не из
      `UnitOfWorkPort`.
- [x] ~~`audit-field-whitelist.ts`~~ — закрыто deny-list'ом
      `application/platform/audit/audit-redaction.util.ts` (`4463e0d`), см. врезку к пункту 1
      раздела «Что реально открыто».
- [x] Хеш адреса — `infrastructure/crypto/address-hasher.adapter.ts` (тот же, что у сессий);
      отдельной утилиты хеширования адреса в `infrastructure/security/` нет и не нужно.
- [x] Подключение `AuditLoggerPort` в существующие use-cases — 44 вызова
      (`grep -rc 'audit\.record(' packages/server/src/application`); EPIC-014/015 ещё нет.
- [ ] Протяжка `requestId` **в конверт outbox-события** — outbox в коде нет. Половина HTTP →
      `RequestContextPort` → аудит работает (`audit-log.adapter.ts` берёт `requestId` из контекста).
- [x] Правила п. 7 (включая агрегацию серий) — отгружено 2026-09-06 как
      `application/access/use-cases/record-denied-access.use-case.ts` плюс отбор в
      `domain/access/denied-access-audit.policy.ts`. Имя другое, чем планировалось здесь: суффикс
      `.service.` не входит в закрытый словарь `rules/naming-and-structure.mdc` и отвергается линтом.
      Агрегация серий не потребовала планировщика — она стоит на бюджете `access_denial_audit`.
- [x] Тесты п. 1, 2, 5: `test/unit/audit/audit-log-adapter.test.ts`,
      `test/unit/audit/audit-coverage.test.ts`, `test/unit/audit/audit-redaction-corpus.test.ts`,
      `test/integration/db/audit-trail-writes.test.ts`; сверх плана —
      `test/unit/audit/audit-unscoped-guard.test.ts` и гейт адреса
      `test/contract/audit-privileged-ip-address.test.ts`.
- [x] Тесты п. 7 — `test/unit/domain/access/denied-access-audit.policy.test.ts`,
      `test/unit/application/record-denied-access.use-case.test.ts`,
      `test/unit/http/denied-access-audit-wiring.test.ts` (положительные контроли: успешный запрос,
      рядовой отказ на `GET` и не-отказ не пишут ничего).
- [ ] Тесты п. 9: деградация `INFO` при сбое записи.

## Что уже сделано — и **не этой историей**

Раздел переписан после сверки с кодом. Прежняя редакция создавала впечатление, что история наполовину
отгружена; это не так. Всё перечисленное ниже приехало с **другими** историями попутно, потому что
привилегированное действие дешевле записать в тот же коммит, что и само действие, чем искать его
потом в выросшей кодовой базе. Собственный вклад 016-02 — whitelist полей, аудит отказов, метрики,
сквозной `requestId` через outbox, замер накладных расходов — не сделан ни в какой части.

Кто что отгрузил:

- [x] **Порт и pino-адаптер — STORY-009-06.** `application/platform/ports/audit-logger.port.ts` и
      `infrastructure/logging/pino-audit.adapter.ts` появились коммитом `0b32d0a`
      («feat(audit): open the trail with sign-in inside it») вместе с первым вызовом. Проверяется
      `git log --oneline -- packages/server/src/application/platform/ports/audit-logger.port.ts`.
- [x] **Таблица, партиции и append-only — STORY-016-01** (`status: review`): миграция
      `prisma/migrations/20260805110000_audit_logs`, тесты
      `test/unit/audit/audit-partitions.test.ts` и `test/integration/db/audit-log-append-only.test.ts`.
- [x] **Запись в той же транзакции — STORY-016-01** (коммит `7070c25`):
      `infrastructure/persistence/prisma/audit-log.adapter.ts` берёт транзакцию из `withTenant` через
      AsyncLocalStorage, как её берут репозитории. Откат изменения откатывает и запись; доказано
      `test/integration/db/audit-trail-writes.test.ts` с положительным контролем.
- [x] **`severity` от действия, а не от места вызова:** `AUDIT_ACTION_SEVERITY` в
      `packages/shared/src/audit` (`Record<AuditAction, …>` — действие без уровня не компилируется).
- [x] **Адрес не хранится:** в `ip_hash` идёт ключевой хеш (`infrastructure/crypto/address-hasher.adapter.ts`,
      тот же, что у сессий); `request_id` адаптер берёт из `RequestContextPort`, когда use-case его
      не передал.
- [x] **События без организации идут в лог — но только те, что в списке (переписано 2026-08-16).**
      Прежняя редакция этого пункта описывала снятое поведение и опиралась на посылку, которая при
      проверке не подтвердилась: «часть привилегированных действий происходит до того, как
      организация известна». Из двух кандидатов, которыми это оправдывали, не подошёл ни один —
      `organization.registered` пишется **внутри** `withTenant` уже созданной организации
      (`register-organization.use-case.ts`), а отказ во входе не имеет действия в каталоге вовсе.

      Решение по обстоятельствам («нет скоупа / нет `organizationId` / скоуп не совпал») не называло
      действия, а значит покрывало все: use-case, чей вызывающий вышел из ambient-области, возвращал
      успех и оставлял привилегированное действие строкой в ротируемом логе. Порт обещает обратное.
      Теперь список — `AUDIT_ACTIONS_WITHOUT_ORGANIZATION` (`application/platform/audit/`), в нём
      одно действие `rls.bypassed`, чьё определение и есть «вне арендатора»; остальное отвергается
      `AuditTrailUnscopedError`, отказ доходит до вызывающего и откатывает транзакцию. Расширение
      списка ловит отдельный гейт по составу. Деградация посчитана — `audit_unscoped_total`.

      Несовпадение `organizationId` со скоупом по-прежнему отвергается: положить такую запись под
      скоуп значило бы записать событие организации B в журнал организации A.
- [x] **Вызовы `audit.record` в use-cases** принесли доменные эпики (011, 012, 013) — каждый со своим
      действием, а не эта история. Список файлов печатает
      `grep -rl 'audit\.record(' packages/server/src/application`.
- [x] **Гейт покрытия `audit-coverage` существует и работает** —
      `packages/server/test/unit/audit/audit-coverage.test.ts`. Он читает исходники, проверяет обе
      стороны (действие каталога без вызывающего **и** имя, выдуманное на месте вызова) и имеет
      CONTROL-кейс на непустоту скана. Утверждение прежней редакции, что такой гейт «имеет смысл,
      когда список перестанет расти», устарело.

Про acceptance 2 прежняя редакция была неверна фактически: из названных там семейств `role.*`,
`permission.override.*` и `user.mfa_*` **отгружены** и имеют вызывающего — все три в
`packages/shared/src/audit/audit-action.enums.ts`. Открыты только `acl.*` (домена ресурсного ACL нет,
STORY-011-06 заблокирована до EPIC-014) и `file.*` (EPIC-015).

## Что реально открыто

1. **Whitelist полей (acceptance 5) не построен.** Файла
   `application/platform/audit/audit-field-whitelist.ts` не существует, корпус-теста
   `audit-redaction-corpus.spec.ts` нет. Сегодня отсутствие секретов в `before`/`after` держится
   дисциплиной вызывающего и комментарием в `audit-logger.port.ts` — то есть свойством, которое
   ничто не проверяет. `test/unit/logging/redaction.test.ts` покрывает **логи**, а не аудит:
   `REDACTED_PATHS` к колонкам `before`/`after` не применяется.

   > **Закрыто 2026-09-06, другим решением.** Deny-list
   > `packages/server/src/application/platform/audit/audit-redaction.util.ts` (коммит `4463e0d`)
   > прогоняется в `PrismaAuditLogger.record` до записи и до лог-стока, корпус-тест
   > `packages/server/test/unit/audit/audit-redaction-corpus.test.ts` читает вызовы из дерева.
   > Whitelist отвергнут осознанно, обоснование — в докстринге `audit-redaction.util.ts`; задача
   > «`audit-field-whitelist.ts`» в списке выше закрыта этим, а не осталась висеть.
2. **Аудит отказов в доступе (acceptance 7) — закрыт 2026-09-06; ниже история пункта.** Здесь стояло «метрики `permission_denied_total{reason}` нет —
   `MetricsPort` объявляет три метрики», и это перестало быть правдой: метрика заведена коммитом
   `b0df0c6` (`incrementPermissionDenied(reason)` в порту, `permission_denied_total` с меткой
   `reason` в `prom-client.adapter.ts`), а в самом порту сегодня не три метода, а больше —
   актуальный состав печатает
   `grep -n '^  [a-z].*(' packages/server/src/application/platform/ports/metrics.port.ts`.
   Открытым остаётся то, что метрика не заменяет: **действия отказа в каталоге аудита нет**,
   `application/access/services/denied-access-audit.service.ts` не существует, агрегата серий нет
   (планировщика и очереди в продукте тоже нет). То есть на `GET` сигнал есть и он безадресный —
   счётчик по причине, без актора и без ресурса, — а записи, по которой можно установить, кому
   отказали, нет. Формулировка «признано в двух местах и не должно открываться заново» относится
   к записи, а не к метрике; сами эти два места (`docs/security/permission-model.md`, раздел «Чего
   нет», и комментарий к `permission.inspected` в
   `packages/shared/src/audit/audit-action.enums.ts`) сверены и говорят то же.

   > **Закрыто 2026-09-06 — вместе с аудитной половиной критерия 2 STORY-011-07**, той самой её
   > частью, что не зависела от ресурсного ACL. Абзац выше описывает состояние до этой даты.
   >
   > Сделано так, как этот пункт и предполагал, с тремя отличиями от плана. Путь отдельный —
   > `packages/server/src/application/access/use-cases/record-denied-access.use-case.ts`, со своим
   > `withTenant` на актора отказа, вызванный из общего обработчика ошибок; действия в каталоге
   > заведены (`access.denied`, `access.denial_burst`). Отличия:
   >
   > 1. **имя файла не `denied-access-audit.service.ts`.** Суффикс `.service.` не входит в закрытый
   >    словарь `rules/naming-and-structure.mdc` и отвергается линтом (`bad-crm/require-role-suffix`);
   >    это `use-case`, потому что это одна команда в одной транзакции;
   > 2. **`AUDIT_ACTIONS_WITHOUT_ORGANIZATION` не расширен.** Альтернатива из этого пункта —
   >    «либо действия в каталоге, либо лог-сток для `not_authenticated`» — решена в пользу
   >    первого **и** отказа от второго: неаутентифицированный отказ не пишется вообще, потому что
   >    у него нет субъекта, а направлять этот поток в канал журнала значило бы отдать
   >    единственный неограничиваемый источник трафика в самый дорогой сток;
   > 3. **агрегат серий не отложен.** Он не потребовал ни планировщика, ни очереди: бюджет
   >    `access_denial_audit` в Redis (11 записей на актора в минуту) даёт «> 10 за минуту — одной
   >    записью» напрямую — одиннадцатая granted-точка и есть сводка, всё после неё лимитер
   >    отвергает.
   >
   > Мера, ради которой всё это: 5000 отказов подряд от одного актора дают 11 строк
   > (`test/unit/application/record-denied-access.use-case.test.ts`, «bounds what a refused caller
   > can make the database write»). Контрфакт — не «300 в минуту по `api_request`»: эта политика
   > **не** смонтирована как ambient-миддлварь (`grep -rn "'api_request'" packages/server/src` даёт
   > три вызова, все внутри `identity`), так что без нового бюджета потолка не было бы вообще.
3. **Разделение по severity при сбое записи (acceptance 9) не сделано.** Сегодня падение вставки
   роняет транзакцию для любого события, включая `INFO`. **Уточнено 2026-08-30:** метрика
   `audit_write_failed_total` в коде **есть** (`incrementAuditWriteFailed` в `MetricsPort`,
   счётчик в `prom-client.adapter.ts`) — здесь утверждалось обратное со ссылкой на `grep`, который
   сегодня печатает не пусто. Отсутствует не метрика, а сама деградация: у `INFO` нет пути
   «не смогли записать — посчитали и пошли дальше», поэтому счётчик считает то, что и так уронило
   транзакцию.
4. **Накладные расходы (acceptance 10) не измерены.** Нагрузочного сценария нет; утверждение «одна
   вставка без дополнительных чтений» — про конструкцию адаптера, а не про замер.
5. **`session.refresh_reuse_detected` отсутствует при существующем домене.** Обнаружение повторного
   использования refresh-токена реализовано —
   `application/identity/use-cases/refresh-session.use-case.ts` отзывает семью и пишет
   `logger.warn` с `event: SECURITY_EVENTS.refreshReuseDetected`, — но строки в `AuditLog` нет.
   Это **единственный** пункт списка acceptance 2, чей домен уже отгружен, а действия в каталоге нет;
   всё остальное недостающее ждёт своего домена. Лог ротируется и не защищён
   `REVOKE UPDATE, DELETE` — событие безопасности в нём не заменяет журнал.

   > **Закрыто 2026-09-06.** Действие `session.refresh_reuse_detected` есть в
   > `packages/shared/src/audit/audit-action.enums.ts`, запись — в
   > `packages/server/src/application/identity/use-cases/refresh-session.use-case.ts:178` (внутри той
   > же транзакции, что и отзыв семьи), доказательство —
   > `packages/server/test/unit/application/refresh-session.use-case.test.ts:271` и
   > `packages/server/test/unit/audit/audit-logger.test.ts:139`. Пункт списка acceptance 2 больше не
   > открыт; открытыми там остаются только `acl.*` и `file.*`, чьих доменов нет.
6. **Адрес доходит до записи в меньшинстве вызовов.** Остальные передают `ipAddress: undefined`, то
   есть пишут `ip_hash = NULL`, и «тот же адрес снова» по журналу не отвечается. Числа здесь
   намеренно не записаны — печатают команды:

   ```bash
   grep -rc 'audit\.record(' packages/server/src/application --include='*.ts' | awk -F: '{s+=$2} END {print s}'
   grep -rhA8 'audit\.record(' packages/server/src/application | grep -c 'ipAddress: input\.'
   grep -rhA8 'audit\.record(' packages/server/src/application | grep -c 'ipAddress: undefined'
   ```

   Причина отложена осознанно и описана в `application/iam/use-cases/reset-user-mfa.use-case.ts`
   (комментарий про `ipAddress: undefined` в `application/iam/**`) — эта история её закрывает.

   > **Закрыто 2026-09-06.** «Меньшинство» перевернулось: команды выше печатают сегодня 44 вызова,
   > 23 с адресом из запроса и 13 с `undefined` (остальные — без поля вовсе). Важнее числа то, что
   > остаток теперь не дисциплина, а гейт:
   > `packages/server/test/contract/audit-privileged-ip-address.test.ts` вместе с
   > `packages/server/test/contract/support/audit-record-call.util.ts` выводит из severity действия
   > и из текста вызова, обязан ли этот вызов нести адрес, и падает на следующем, который забудет.
   > `ipAddress: undefined` там, где актор системный или действие `INFO`, — не дефект, а то, что
   > гейт разрешает по имени.
7. **Сквозной `requestId` через outbox (acceptance 4) непроверяем в принципе:** outbox в коде нет
   (`find packages/server/src -iname '*outbox*'` печатает пусто). Проверить можно только участок
   HTTP → `RequestContextPort` → аудит; часть про job проверяется, когда появится очередь.

**Расхождение имён в acceptance 2, требующее решения до реализации гейта.** Список критерия называет
`user.login`/`user.logout`, `user.invited`/`user.accepted`; каталог отгрузил их под другими именами —
`session.signed_in`/`session.revoked`, `invitation.created`/`invitation.accepted`. Табличный гейт,
написанный буквально по списку критерия, падал бы на несуществующих именах. Списка также нет:
`permission.override.expired`, `permissions.recomputed`, `organization.security_policy_updated`,
`organization.settings_updated`, `user.impersonation_started/ended`, `audit.exported`,
`organization.data_exported`, `report.exported` — часть из них про домены, которых нет. Сверять
критерий с каталогом — первая задача истории, а не правка по ходу написания теста.

## Ссылки

- [`permission-model.md` §10 «Аудит»: таблица событий, «Что именно кладём в before/after», «Отказы»](../../../docs/security/permission-model.md)
- [`data-model.md`, группа 14, `AuditLog`, `OutboxEvent`](../../../docs/architecture/data-model.md)
- [`threat-model.md`, `T-PLAT-05`, `T-PLAT-06`, `T-PLAT-09`, `T-TASK-04`](../../../docs/security/threat-model.md)
- [`overview.md`, «(в) Транзакционный outbox», «(з) Observability»](../../../docs/architecture/overview.md)
- PRD: NFR-6

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
