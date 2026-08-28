---
id: STORY-013-02
epic: EPIC-013
status: in-progress
blocked: false
priority: must
estimate: M
---

# STORY-013-02 — Коды восстановления

**Как** сотрудник **я хочу** получить набор одноразовых кодов восстановления при включении 2FA,
**чтобы** потеря телефона не означала потерю доступа к рабочему пространству и обращение к
администратору.

## Acceptance (Given/When/Then)

1. **Генерация при включении.**
   Given пользователь подтвердил TOTP;
   When завершается `confirm`;
   Then генерируются 10 кодов по 10 символов из безопасного алфавита (без похожих `0/O`, `1/l`),
   каждый из CSPRNG; ответ содержит их **открытым текстом ровно один раз**; в БД — только
   argon2id-хеши в таблице `mfa_recovery_codes`.

2. **Показ один раз.**
   Given коды выданы;
   When пользователь обновляет страницу или повторно запрашивает список;
   Then открытые значения недоступны навсегда: API отдаёт только счётчик
   `{ total: 10, remaining: 10 }`; UI перед закрытием требует подтвердить «я сохранил коды»
   и предлагает скачать `.txt` / распечатать.

3. **Одноразовость под конкуренцией.**
   Given валидный неиспользованный код;
   When он предъявляется двумя параллельными запросами;
   Then ровно один успешен: пометка выполняется атомарным
   `UPDATE mfa_recovery_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id`,
   выдача сессии — только при вернувшейся строке (конкурентный тест на N параллельных запросов).

4. **Вход по коду восстановления.**
   Given у пользователя нет доступа к аутентификатору;
   When он вводит код восстановления на шаге второго фактора;
   Then сессия выдаётся, код помечается использованным, в `AuditLog` —
   `user.mfa_recovery_code_used` (`severity = warning`), владельцу уходит уведомление (in-app
   всегда, email при настроенном SMTP).

5. **Негативный сценарий — повторное использование.**
   Given код уже использован;
   When он вводится снова;
   Then 401 с тем же телом и тем же временем ответа, что и для несуществующего кода
   (неразличимость), попытка учитывается лимитером.

6. **Предупреждение об исчерпании.**
   Given остаётся ≤ 3 неиспользованных кода;
   When пользователь входит;
   Then в интерфейсе — постоянный баннер «осталось N кодов, перевыпустите набор»; при 0 оставшихся
   вход по кодам невозможен, доступен только TOTP или сброс администратором.

7. **Перевыпуск набора.**
   Given пользователь запрашивает новые коды;
   When `POST /api/v1/auth/2fa/recovery-codes/regenerate` с подтверждением паролем и текущим
   TOTP-кодом;
   Then **все** старые хеши удаляются в той же транзакции, выдаётся новый набор из 10 кодов, в
   `AuditLog` — `user.mfa_recovery_codes_regenerated`.

8. **Негативный сценарий — перевыпуск без подтверждения.**
   Given запрос без пароля или без действующего TOTP-кода;
   When он приходит;
   Then 403 `reauthentication_required`; старые коды остаются рабочими.

9. **Хеши, а не значения.**
   Given таблица `mfa_recovery_codes`;
   When она читается напрямую;
   Then в ней только `code_hash` (argon2id с параметрами не ниже OWASP), `used_at`, `created_at`;
   plaintext-колонки нет; grep-тест логов не находит кодов; сравнение — с фиктивной проверкой при
   отсутствии совпадения, чтобы время ответа не выдавало существование кода.

10. **Rate limiting.**
    Given перебор кодов восстановления;
    When превышено 5 попыток за 15 минут на пользователя и на IP;
    Then 429 с `Retry-After`; серия неудач пишется одной агрегированной записью в `AuditLog` и
    метрикой `mfa_recovery_failed_total`.

11. **Кросс-тенантность.**
    Given коды пользователя организации B;
    When они предъявляются в контексте организации A;
    Then 401 без раскрытия причины; RLS изолирует таблицу, isolation-тест это подтверждает.

## Задачи

- [x] `packages/server/prisma/migrations/20260811093000_mfa_recovery_codes/migration.sql` — таблица с
      `organization_id`, `user_id`, `code_hash`, `used_at`, частичный индекс
      `idx_mfa_recovery_codes_org_user_unused (organization_id, user_id) WHERE used_at IS NULL`
      (плюс полный `idx_mfa_recovery_codes_org_user`), RLS `ENABLE` + `FORCE` + политики
      `tenant_isolation` и `maintenance_access`, составной FK на `users (organization_id, id)`;
      `UPDATE` и `DELETE` выданы намеренно (`used_at` и перевыпуск).
- [x] `packages/server/src/application/identity/use-cases/generate-recovery-codes.use-case.ts`,
      `consume-recovery-code.use-case.ts`, `regenerate-recovery-codes.use-case.ts`,
      `read-recovery-code-status.query.ts` (счётчик `{ total, remaining }` — в исходной формулировке
      задачи отсутствовал, хотя критерий 2 его требует).
- [x] `packages/server/src/application/identity/ports/password-hasher.port.ts` — переиспользование
      argon2id-адаптера для хеширования кодов, включая `dummyHash`.
- [x] `packages/server/src/domain/identity/recovery-code.value.ts` — алфавит без `0/O` и `1/I/L`,
      длина, счёт, `normalizeRecoveryCode`, `isWellFormedRecoveryCode`. Размер алфавита печатает
      `node -e "const s=require('fs').readFileSync('packages/server/src/domain/identity/recovery-code.value.ts','utf8');console.log(/RECOVERY_CODE_ALPHABET\s*=\s*'([^']*)'/.exec(s)[1].length)"`.
- [x] `packages/server/src/presentation/http/route-registry.factory.ts` — `2fa/recovery-codes`
      (`GET`) и `2fa/recovery-codes/regenerate` (`POST`). `consume` получил свой маршрут позже,
      вместе с [STORY-013-03](story-013-03-login-second-factor.md) — `POST /auth/2fa/verify`.
- [x] `packages/client/src/widgets/recovery-codes/recovery-codes.widget.tsx` + баннер
      `ui/recovery-codes-low-banner.component.tsx`; список, диалог с подтверждением «я сохранил» и
      форма перевыпуска живут в `units/auth/ui/` (`recovery-codes-list`, `recovery-codes-dialog`,
      `regenerate-recovery-codes-form`) — они доменные; скачивание `.txt` —
      `units/auth/lib/download-recovery-codes.util.ts` с собственным юнит-тестом.
- [x] `packages/client/src/units/auth/service/mutations/regenerate-recovery-codes.mutation.ts` +
      `queries/recovery-code-status.query.ts`, `hooks/use-recovery-codes.hook.ts`.
- [x] Тесты: `test/unit/application/consume-recovery-code.use-case.test.ts`, конкурентный
      `test/integration/db/mfa-recovery-code-race.test.ts` (п. 3, на реальном Postgres),
      `test/unit/domain/recovery-code.value.test.ts`,
      `test/unit/crypto/csprng-recovery-code-generator.adapter.test.ts`,
      `test/unit/application/{regenerate-recovery-codes.use-case,read-recovery-code-status.query}.test.ts`,
      `test/integration/http/mfa-endpoints.test.ts` (п. 7, 8, 10), `test/unit/persistence/mfa-repositories.test.ts`;
      isolation-тест таблицы приходит реестровым набором — `mfa_recovery_codes` добавлена в
      `TENANT_TABLES`, по которому идёт `test/integration/db/rls-isolation.test.ts`.
- [x] Постоянная стоимость сравнения (п. 9) — `consume-recovery-code.use-case.test.ts`, блок «the
      fixed-cost match — L-2 / timing»: набор из одного кода стоит **столько же** проверок Argon2id,
      сколько полный, а малформед отвергается до первой проверки вовсе. Отдельного файла
      `recovery-code-timing` нет и не нужно: замер стенных часов был бы флаки-тестом на CI, а
      утверждение здесь — про число вызовов хешера, и оно детерминированно.
- [x] Структурный тест «plaintext-колонки нет» (п. 9) —
      `test/unit/persistence/mfa-recovery-code-structure.test.ts`: `codeHash` обязан быть, `code`,
      `plainCode`, `plaintextCode` и `recoveryCode` — отсутствовать; `recoveryCodes` обязан стоять в
      `REDACTED_PATHS` (это и есть заявленный «греп логов», сведённый к проверяемому факту).
- [ ] E2E именно **входа по коду восстановления** — `packages/e2e/tests/auth/login-with-2fa.spec.ts`
      доводит до шага второго фактора и проверяет, что переход «использовать код восстановления»
      предложен, но сам вход по коду сквозь браузер не прогоняется; трата кода покрыта
      `consume-recovery-code.use-case.test.ts` и `test/integration/db/mfa-recovery-code-race.test.ts`.
      Поверхность принадлежит [STORY-013-03](story-013-03-login-second-factor.md), там же и владелец
      этого сценария.

## Ссылки

- [`threat-model.md`, `T-IAM-04` («recovery-коды хранятся argon2id-хешами и помечаются
  использованными атомарно»), `T-IAM-03`](../../../docs/security/threat-model.md)
- [`stack.md`, `@node-rs/argon2`](../../../docs/architecture/stack.md)
- [`ux-architecture.md`, `/settings/security`, «Копирование секрета в буфер»](../../../docs/architecture/ux-architecture.md)
- [`rls-design.md`, чек-лист «новая таблица»](../../../docs/security/rls-design.md)
- PRD: NFR-6

## Сделано (2026-08-12) — серверная половина

### Одноразовость доказана базой, а не сравнением в коде

Совпадение кода с хешем ничего не решает: два запроса могут разрешить **одну и ту же** строку — они
считают одно и то же сравнение против одного и того же хеша. Спор выигрывает единственный оператор
`UPDATE mfa_recovery_codes SET used_at = $2 WHERE id = $1 AND used_at IS NULL RETURNING id`
(`RecoveryCodeRepositoryPort.markUsed`): у кого вернулась строка, тот и потратил код. Проверено не
дублями и не моками, а `test/integration/db/mfa-recovery-code-race.test.ts` — параллельные запросы на
реальном Postgres в контейнере. Проигравший получает **тот же** отказ, что и «такого кода нет»:
второй, более точный ответ подтвердил бы, что код был настоящим секунду назад.

### Хеши существующим механизмом, не новым

Коды хешируются тем же `PasswordHasherPort`, что и пароли — argon2id через `@node-rs/argon2`, с теми
же параметрами и тем же `dummyHash`. Отдельный «более лёгкий» хешер для кодов не заведён: параметры
стоимости тогда пришлось бы обосновывать дважды, а `dummyHash` для равенства времени — иметь в двух
экземплярах. Отсюда же следует, почему поиск кода — цикл, а не запрос по индексу: argon2id солит
каждую строку отдельно, равенства для `WHERE` не существует.

### Перевыпуск — одна транзакция, и счётчик двигается

`deleteAllForUser` идёт **до** `issueFor` внутри одного `withTenant`: сбой в середине оставляет
«ничего не изменилось», а не «старых кодов уже нет, новые не записались» (критерий 7). Принятый при
реаутентификации TOTP-код сразу двигает `totp_last_counter` (`advanceCounter`) — иначе тот же код в
пределах своих тридцати секунд остался бы «неиспользованным» с точки зрения анти-replay и годился бы
для повторного предъявления на шаге входа.

### Один отказ на три состояния

`reauthentication_required` отвечает и на неверный пароль, и на неверный код, и на «у аккаунта TOTP
вообще не включён»; обе проверки выполняются **всегда** (`Promise.all`), а не по короткому замыканию,
чтобы по тому, до какой из них дошло выполнение, нельзя было различить причины (критерий 8).

### Таблица закрыта полным блоком RLS

`ENABLE` + `FORCE`, политика `tenant_isolation` на роль `app_user` с `USING` **и** `WITH CHECK`,
составной внешний ключ на `users (organization_id, id)` — проверки FK исполняются владельцем таблицы и
RLS обходят, поэтому односоставная ссылка могла бы назвать учётку чужой организации. Изоляция
проверяется не отдельным тестом, а реестром: `mfa_recovery_codes` внесена в `TENANT_TABLES`, а
`rls-isolation.test.ts` перебирает реестр целиком и требует положительный контроль (критерий 11).

## Что отложено, и почему

- ~~**Весь клиент (критерии 2 и 6)**~~ — **закрыто (2026-08-12, `430457e`).** Записано было, что ни
  одного из компонентов нет, потому что нет экрана `/settings/security`. Экран есть (тот же корень,
  что у критерия 10 [STORY-013-01](story-013-01-enable-totp.md), см. там же). Подтверждение «я
  сохранил коды» — `Checkbox` в `units/auth/ui/recovery-codes-dialog.component.tsx`, который держит
  закрытие диалога и его крестик заблокированными, пока не отмечен; скачивание `.txt` —
  `units/auth/lib/download-recovery-codes.util.ts`; печать — `globalThis.print()` с
  `data-bc-print-hidden` на управляющих элементах; постоянный баннер — `widgets/recovery-codes/ui/
  recovery-codes-low-banner.component.tsx` с раздельными формулировками для «осталось N» и «не
  осталось ни одного». Серверная половина обоих критериев была сделана и раньше: коды отдаются
  открытым текстом **ровно один раз** в ответе на `confirm`/`regenerate` и больше нигде, а
  `GET /auth/2fa/recovery-codes` отвечает только `{ total, remaining }`.
- **Уведомление владельцу учётки при использовании кода (критерий 4)** — **открыто.** In-app-канала
  в продукте нет вообще (`packages/server/src` не содержит ни одного модуля уведомлений), а
  `ConsumeRecoveryCodeUseCase` не вызывает `MailDispatchPort` ни разу. В `AuditLog` факт пишется
  (`user.mfa_recovery_code_used`), наружу не уходит ничего.

  > **Поправка 2026-08-28 (`1e51d69`, 2026-08-12): обоснование было неверным, вывод — верен.**
  > Здесь стояло, что «письмо вне транзакции требует outbox (ADR-0021 принят, механизм не
  > реализован)». Посылка неверна: почта в этой сборке отправляется **после коммита транзакции**
  > через `MailDispatchPort.dispatch` (fire-and-forget, никогда не бросает) — ровно так это делает
  > соседний `confirm-totp.use-case.ts`, посылая «two-factor authentication was turned on», и так же
  > `reset-user-mfa`. Канал есть, и outbox для этого письма не нужен. Не хватает не механизма, а
  > самого вызова в `consume` — и in-app-половины критерия, у которой канала действительно нет.
- ~~**Ключ ограничителя только по пользователю, без IP (критерий 10)**~~ — **закрыто в основной
  части (2026-08-13, `924411b`), одна половина остаётся открытой.** Записано было, что политика
  `mfa_recovery_consume_attempt` объявлена как `UserSubject` и IP-половины нет. Сегодня в
  `application/platform/ports/rate-limit.port.ts` она объявлена как `IpUserSubject` — адрес плюс
  `userId`, который несёт промежуточный токен, — вместе с `mfa_verify_account_attempt`.

  Что при этом **осталось** открытым и не выдумано: распределённая активность по адресам — «один IP
  пробует коды к сорока учётным записям». Ключ `(ip, userId)` даёт нападающему свежий бюджет на
  каждую следующую жертву с того же адреса; счётчика по одному лишь адресу нет. Это записано и в
  самом коде — в докстринге `IpUserSubject`, — а не только здесь.

  > **Поправка 2026-08-28 (`e5e0c84`, 2026-08-13).** Отдельным пунктом здесь стояло, что комментарий
  > порта «обосновывает решение посылкой, которой в коде нет»: описывает субъект как
  > `pending:{userId}`, тогда как «строки `pending:` в `packages/server/src` не существует вовсе».
  > Не существовало — на день, когда это писалось. Промежуточный токен вышел с
  > [STORY-013-03](story-013-03-login-second-factor.md):
  > `infrastructure/crypto/jwt-mfa-pending-token.adapter.ts` объявляет `SUBJECT_PREFIX = 'pending:'`
  > и пишет его в `sub`. Комментарий порта описывал систему, которая тогда ещё не вышла, — и вышла.
- **Метрика `mfa_recovery_failed_total` и агрегированная запись серии неудач в `AuditLog`
  (критерий 10)** — **открыто.** Отдельная неудача пишется в лог событием `recovery_code_refused`, а
  429 попадает в общий `incrementAuthRateLimited` по шаблону маршрута. Специализированной метрики
  нет: `application/platform/ports/metrics.port.ts` объявляет только `observeHttpRequest`,
  `incrementAuthRateLimited` и `render` — актуальный список печатает
  `grep -n '^  [a-z].*(' packages/server/src/application/platform/ports/metrics.port.ts`. Прежнее
  обоснование («заводить её до появления маршрута, который эти неудачи производит, значило бы
  измерять то, чего никто не вызывает») **отпало**: маршрут `POST /auth/2fa/verify` существует и эти
  неудачи производит. Держать метрику нечем — порт под неё не расширен, и это работа, а не довод.
- ~~**Вход по коду восстановления целиком (критерии 4, 5, 11 в части «предъявляется на шаге второго
  фактора»)**~~ — **закрыто (2026-08-13, `c5a50b6`).** Записано было, что
  `ConsumeRecoveryCodeUseCase` написан, но не подключён ни к контейнеру, ни к реестру маршрутов, и
  что прямое следствие видно в контракте — `recovery_code_invalid` как компонент с нулём `$ref`.
  Обе половины мертвы: use-case собран в `infrastructure/bootstrap/container.factory.ts`, маршрут
  `POST /auth/2fa/verify` стоит в `route-registry.factory.ts`, а отдельного компонента у кода
  отказа больше нет — он один из кодов, описанных в `SecondFactorRefused`, на который этот
  маршрут и ссылается. Поверхность, как и планировалось, закрыта
  [STORY-013-03](story-013-03-login-second-factor.md).

## Блокирующая зависимость, созданная этой историей — снята

Перевыпуск набора требует **живого TOTP-кода** — то есть набор кодов не умеет продлевать сам себя.
Отсюда выводилось: **[STORY-013-03](story-013-03-login-second-factor.md) не выходит раньше
[STORY-013-04](story-013-04-disable-totp.md)** — полная формулировка в [`epic.md`](../epic.md),
раздел «Блокирующая зависимость внутри эпика».

> **Поправка 2026-08-28: порядок соблюдён (`1e51d69`, 2026-08-12 — раньше `c5a50b6`, 2026-08-13).**
> Здесь стояло, что человек, вошедший по коду восстановления, сожжёт весь набор и «запрётся
> окончательно, потому что отключения и административного сброса не существует». Оба существуют, обе
> истории в `review`: `POST /auth/2fa/disable` принимает неиспользованный код восстановления наравне
> с живым TOTP-кодом, а `POST /users/{userId}/reset-mfa` снимает второй фактор со стороны. Тупика,
> ради которого зависимость записывалась, больше нет — кроме единственного владельца организации,
> сбросить которого некому по построению (см. [STORY-013-01](story-013-01-enable-totp.md), тот же
> раздел).

## Definition of Done

- [x] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [x] Commit-гейт зелёный — FAIL волны 2026-08-12 закрыты 2026-08-28 (`354e880`, `2c5540e`,
      `a8b63dd`, `7b60154`, `f17e652`)
- [x] Документация обновлена (`openapi.yaml`, `data-model.md`, CHANGELOG + запись в `docs/brain/`)
- [x] a11y и i18n — виджет кодов и баннер живут на `/settings/security`, axe гоняется в
      `enable-2fa.spec.ts`, ключи `security.codes.*` заведены в EN и RU наравне, включая
      плюрализацию счётчика (`test/i18n/plural.test.ts`)
- [x] **Isolation-тест RLS** — `mfa_recovery_codes` внесена в `TENANT_TABLES` и покрыта реестровым
      `rls-isolation.test.ts` с положительным контролем
- [x] **Permission объявлена** — обе записи реестра self-service, обоснование записано в реестре и в
      `x-self-service-reason` спеки; перевыпуск авторизуется реаутентификацией, а не capability
