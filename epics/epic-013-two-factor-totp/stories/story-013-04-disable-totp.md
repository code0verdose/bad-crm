---
id: STORY-013-04
epic: EPIC-013
status: review
blocked: false
priority: must
estimate: S
---

# STORY-013-04 — Отключение и сброс 2FA

**Как** сотрудник **я хочу** отключить второй фактор осознанно — подтвердив пароль и код, — а при
потере аутентификатора получить сброс от администратора, **чтобы** ни случайный клик, ни украденная
сессия не снимали защиту, но и утеря телефона не оставляла меня без доступа навсегда.

> **Эта история разблокировала [STORY-013-03](story-013-03-login-second-factor.md) — условие
> выполнено 2026-08-12.** Пока выхода из 2FA в продукте не было ни одного, а перевыпуск кодов
> требовал живого TOTP-кода, STORY-013-03 держалась `blocked: true` и не могла выйти раньше этой.
> Оба выхода отгружены (`POST /auth/2fa/disable`, `POST /users/{userId}/reset-mfa`), пометка снята, и
> вход читает второй фактор с коммита `c5a50b6`. Полная формулировка — [`epic.md`](../epic.md),
> раздел «Блокирующая зависимость внутри эпика». Отдельно: `docs/runbooks/incident.md` предписывал
> оператору «сбросить 2FA» без механизма — оговорка снята вместе с выходом этой истории, регламент
> ссылается на `reset-mfa`.

## Acceptance (Given/When/Then)

1. **Самостоятельное отключение.**
   Given пользователь с включённой 2FA;
   When `POST /api/v1/auth/2fa/disable` с `{ password, code }`;
   Then при совпадении обоих факторов: `totpSecretEnc = null`, `totpEnabledAt = null`, **все**
   `mfa_recovery_codes` удаляются в той же транзакции; в `AuditLog` — `user.mfa_disabled`
   (`severity = warning`); пользователю уходит уведомление.

2. **Негативный сценарий — только пароль.**
   Given запрос без `code` (или с неверным);
   When он приходит;
   Then 403 `reauthentication_required`; 2FA остаётся включённой. Код восстановления в качестве
   второго подтверждения допускается и гасится как одноразовый.

3. **Негативный сценарий — украденная сессия.**
   Given атакующий владеет действующим access-токеном, но не знает пароля;
   When он вызывает `disable`;
   Then 403: наличие сессии само по себе недостаточно (защита от `T-IAM-01`).

4. **Негативный сценарий — политика организации требует 2FA.**
   Given обязательная 2FA включена для роли пользователя;
   When он отключает второй фактор;
   Then 409 `mfa_required_by_policy` с текстом «политика организации требует 2FA для вашей роли»;
   отключение возможно только после снятия политики или смены роли.

5. **Административный сброс.**
   Given администратор с правом `user:reset_mfa` (`dangerous`);
   When `POST /api/v1/users/{userId}/reset-mfa` с подтверждением;
   Then 2FA у пользователя снимается, recovery-коды удаляются, **все его сессии отзываются**,
   `permissions_version` инкрементится; в `AuditLog` — `user.mfa_reset_by_admin`
   (`severity = critical`) с актором; владельцу учётки уходит уведомление, которое нельзя отключить
   в настройках.

6. **Негативный сценарий — сброс без права.**
   Given администратор без `user:reset_mfa`;
   When он вызывает эндпоинт;
   Then 403 `permission_not_granted`; кнопка в UI отсутствует.

7. **Негативный сценарий — сброс самому себе.**
   Given администратор вызывает сброс на собственном `userId`;
   When операция выполняется;
   Then 409 `self_lockout`-семантика (`invalid_target`): собственная 2FA снимается только
   самостоятельным путём п. 1 — иначе сброс становится обходом второго фактора.

8. **После сброса — принудительная настройка.**
   Given политика организации требует 2FA и администратор сбросил её пользователю;
   When пользователь входит следующий раз;
   Then он попадает в мастер настройки TOTP и не имеет доступа к остальным маршрутам
   ([STORY-013-05](story-013-05-org-2fa-policy.md)).

9. **Кросс-тенантность.**
   Given `userId` из организации B;
   When администратор организации A вызывает сброс;
   Then **404** `resource_not_found`.

10. **UI-подтверждение.**
    Given экран `/settings/security` и карточка сотрудника в админке;
    When инициируется отключение или сброс;
    Then модалка подтверждения перечисляет последствия (потеря recovery-кодов, отзыв сессий),
    действие пессимистично, тост один, экран проходит axe и локализован EN/RU.

## Задачи

- [x] `packages/server/src/application/identity/use-cases/disable-totp.use-case.ts` — принимает TOTP
      **или** recovery-код как второй фактор; оба проверяются параллельно с паролем, ни один не
      тратится раньше, чем пароль подтверждён верным.
- [x] `packages/server/src/application/iam/use-cases/reset-user-mfa.use-case.ts` — снятие 2FA +
      удаление кодов + отзыв сессий (`SessionRepositoryPort.revokeAllFamilies`, тот же метод, что
      офбординг) + инкремент версии, одной транзакцией. Уведомление — `MailDispatchPort.dispatch`
      после коммита (outbox ещё не существует в проекте, см. STORY-013-01 «Что отложено»; та же
      оговорка применена и здесь).
- [x] `packages/server/src/domain/identity/access/mfa-policy.policy.ts` — `assertNotSelfReset` и
      `assertMfaResetInBounds` (правило подмножества + защита владельца, добавлена аудитом
      безопасности 2026-08-12 — см. «Аудит безопасности» ниже). `assertNotRequiredByPolicy` в этом
      файле так и не заведена, и это уже не пробел: правило приехало со STORY-013-05 как
      `evaluateMfaRequirement` в `mfa-requirement.policy.ts`, а отказ — в `DisableTotpUseCase`
      (см. «Что отложено», критерий 4).
- [x] `packages/server/src/application/identity/use-cases/recovery-code-matcher.use-case.ts` —
      новый файл: сопоставление recovery-кода без его списания, извлечено из
      `ConsumeRecoveryCodeUseCase` и переиспользовано `DisableTotpUseCase`, чтобы не заводить вторую
      реализацию таймингово-безопасного цикла (списание — `RecoveryCodeRepositoryPort.markUsed` —
      осталось одной реализацией, как и было).
- [x] `packages/server/src/application/identity/ports/totp-enrollment.port.ts` +
      `infrastructure/persistence/prisma/totp-enrollment.repository.ts` — новый метод `disable`.
- [x] `packages/server/prisma/schema.prisma` + миграция
      `20260812110000_mfa_reset_session_reason` — новое значение `MFA_RESET_BY_ADMIN` перечисления
      `session_revoked_reason` (аддитивная миграция, `ALTER TYPE ... ADD VALUE`).
- [x] `packages/server/src/presentation/http/route-registry.factory.ts` — `POST /auth/2fa/disable`
      (self-service), `POST /users/:userId/reset-mfa` (`user:reset_mfa`).
- [x] `docs/api/openapi.yaml` — оба маршрута, `DisableTotpRequest`, `ResetMfaResult`; `pnpm api:gen`
      прогнан, сгенерированный клиентский файл обновлён.
- [x] Самостоятельное отключение на клиенте — отгружено отдельной дельтой, под другими именами, чем
      планировалось здесь: `packages/client/src/widgets/disable-totp/disable-totp.widget.tsx` +
      `ui/disable-totp-dialog.component.tsx`, смонтированные на странице
      `pages/settings-security/page.tsx` (маршрут `app/routes/_authenticated/settings/security.tsx`).
- [x] `packages/client/src/units/auth/service/mutations/disable-totp.mutation.ts` +
      `units/auth/model/validation/disable-totp-form.schema.ts`.
- [x] Административный сброс на клиенте (критерий 10) — отгружен 2026-08-14 (`a5bf8b3`):
      секция «Two-factor authentication» внизу карточки сотрудника за `can('user:reset_mfa')`,
      `widgets/reset-mfa/` с диалогом подтверждения третьего уровня (ввод адреса обратно, как у
      офбординга рядом) и отчётом после успеха. Мутация легла в
      `units/employee/service/mutations/reset-user-mfa.mutation.ts`, а не в `units/iam`, как значилось
      здесь: прецедент `deactivateUser` — та же iam-операция с той же карточки — уже живёт в
      `units/employee`, и два места для одной ответственности разошлись бы на первой правке.
- [x] Тесты: `test/unit/application/disable-totp.use-case.test.ts` (п. 1–3, включая рейс по счётчику
      TOTP, недешифруемый секрет, отсутствующая запись credential),
      `test/unit/application/recovery-code-matcher.use-case.test.ts`,
      `test/unit/iam/reset-user-mfa.use-case.test.ts` (п. 5, 7, 9),
      `test/unit/domain/mfa-policy.test.ts`, `test/unit/domain/mfa-changed-mail.test.ts`,
      `test/unit/persistence/mfa-repositories.test.ts` (метод `disable`),
      `test/integration/http/mfa-endpoints.test.ts` (`POST /auth/2fa/disable`, п. 2–3),
      `test/integration/http/reset-user-mfa.test.ts` — интеграционный «после сброса сессии отозваны»
      (п. 5, с настоящим отзывом refresh-cookie), permission-matrix snapshot обновлён.

## Сделано (2026-08-12) — серверная половина

### Второй фактор — TOTP или recovery-код, один и тот же код отказа

Форма `code` решает, какая проверка запускается: `/^\d{6}$/` — TOTP, иначе попытка сопоставить как
recovery-код (после `isWellFormedRecoveryCode`, бесплатной проверки формы). Оба пути и проверка
пароля читаются в `Promise.all` **до** того, как хоть один из них учтён — та же причина, по которой
`RegenerateRecoveryCodesUseCase` не делает short-circuit: иначе по времени ответа можно было бы
понять, какая из двух проверок не прошла. Любой отказ — неверный пароль, неверный/отсутствующий код
в любой форме, отсутствие включённой 2FA вовсе — отвечает одним `reauthentication_required`
(критерий 2). Списание recovery-кода (`markUsed`) и продвижение TOTP-счётчика (`advanceCounter`)
происходят только после того, как пароль подтверждён верным — иначе запрос с правильным кодом и
неправильным паролем сжигал бы код или счётчик впустую.

### Recovery-код сопоставляется, а не списывается, до подтверждения пароля

Это и есть причина, по которой чистое переиспользование `ConsumeRecoveryCodeUseCase.execute()`
(единственного существующего потребителя атомарного списания) не подошло: тот метод сопоставляет и
списывает одним неделимым шагом, что для входа корректно (кроме кода восстановления, второго фактора
там нет), но для `disable` создало бы окно, где код тратится раньше, чем известно, что пароль верен.
Поэтому таймингово-безопасный цикл сравнения вынесен в `RecoveryCodeMatcher` — separate
match-без-spend, вызываемый и `ConsumeRecoveryCodeUseCase`, и `DisableTotpUseCase`. Атомарное
списание (`RecoveryCodeRepositoryPort.markUsed`, `UPDATE ... WHERE used_at IS NULL`) как было одной
реализацией, так и осталось — рефакторинг закрыл именно тот дубль тайминг-цикла, который иначе
пришлось бы написать во второй раз в `disable-totp.use-case.ts`, а не создал второй способ списания.

### Отключение и удаление кодов — одна транзакция; проверка вызывающего — тоже внутри неё

`enrollment.disable` (новый метод порта, зеркало `beginDraft`) и `recoveryCodeRows.deleteAllForUser`
выполняются в одном `unitOfWork.withTenant`. **В отличие от `ConfirmTotpUseCase` и
`RegenerateRecoveryCodesUseCase`, здесь нечего минтить до открытия транзакции** — оба соседа платят
Argon2id заранее только за партию *новых* кодов восстановления, которую вот-вот выпустят; `disable`
партию удаляет, а не создаёт, поэтому такого шага у него нет. Расшифровка TOTP-секрета и его проверка
(либо, для recovery-кода, `RecoveryCodeMatcher.match` с фиксированными `RECOVERY_CODE_COUNT`
Argon2id-сравнениями) происходят **внутри** транзакции, как и у обоих соседей: `UserRepositoryPort
.findCredential` и `TotpEnrollmentRepositoryPort.find` — tenant-scoped чтения, резолвящиеся только
внутри контекста, который открывает эта же `withTenant`; отдельного «read-only tenant scope» для них
в кодовой базе нет. Стоимость ограничена и известна — одна проверка пароля плюс либо расшифровка+одна
проверка TOTP, либо десять фиксированных сравнений (никогда оба сразу — `verifySecondFactor` ветвится
по форме `code`), что укладывается в таймаут транзакции с большим запасом. От конкурентной нагрузки
путь ограничивает `mfa_reauth_attempt`, расходуемый в `execute` до вызова `withTenant`: исчерпавший
бюджет вызывающий до транзакции не доходит вовсе. Расшифрованное значение живёт ровно на длину одной
проверки и никуда не сохраняется.

> **Проверено и отменено 2026-09-06 (STORY-013-06, коммит `317b6b5`).** Абзац выше описывает
> состояние до семафора конкурентности Argon2 и оставлен как запись этого состояния — заголовок
> раздела верен, а его вторая половина («проверка вызывающего — тоже внутри неё») больше нет.
> Argon2id под потолком сначала ждёт слот до `AUTH_ARGON2_QUEUE_TIMEOUT_MS`, а резервный код стоит
> `RECOVERY_CODE_COUNT` таких ожиданий подряд — при бюджете транзакции 5 с
> (`infrastructure/persistence/prisma/tenant.context.ts`, `DEFAULT_TIMEOUT_MS`) под насыщением
> первой умирала бы транзакция, и вызывающий получал бы `500 internal_error` вместо `503` с
> `Retry-After`, которые подготовила очередь. Поэтому команда идёт **тремя фазами**:
> `disable-totp.use-case.ts:166-176` — `read` берёт все строки в одной короткой области, сверки
> (`verifyPassword` и `verifySecondFactor`) идут **вне** транзакции, `disable` открывает вторую
> область на запись. Атомарность не потеряна: решающие записи `advanceCounter` и `markUsed` —
> условные операторы, отвечающие `false`, если кто-то успел раньше. Метод матчера называется
> `RecoveryCodeMatcher.compare` (не `.match`); `listCandidates` — единственное его I/O и остаётся
> tenant-scoped чтением в первой фазе. Актуальное описание — докстринг класса
> `DisableTotpUseCase`, раздел «Disabling and deleting every recovery code are one transaction;
> verifying the caller is not».

### Административный сброс — тот же путь отзыва сессий, что и офбординг

`ResetUserMfaUseCase.reset` вызывает `SessionRepositoryPort.revokeAllFamilies` — тот самый метод,
которым `DeactivateUserUseCase` закрывает сессии офбординга, а не новую реализацию. Инкремент
`permissionsVersion` — через `UserRoleRepositoryPort.bumpPermissionsVersion`, тоже существующий
метод (использован `RevokeRoleUseCase`). Запись `AuditLog` и письмо — после коммита. Число вызовов
внутри транзакции с даты аудита ниже больше не постоянно — см. «Аудит безопасности» — но переиспользуемые
примитивы те же.

### Аудит безопасности (2026-08-12): правило ранга и настоящая идемпотентность

Дельта выше прошла независимый аудит безопасности до коммита; две находки его заблокировали и
исправлены в этой же дельте.

**Правило подмножества и защита владельца (HIGH).** До аудита единственной проверкой цели была
`assertNotSelfReset` — «не сам себе». Держатель `user:reset_mfa` (есть у `owner` и `admin`) мог
вызвать сброс на владельце организации: секрет снят, коды удалены, сессии отозваны, учётка осталась
`ACTIVE` и защищена только паролем. Тот же путь работал «вбок» — админ против админа — и для любой
кастомной роли с этим правом. Это ровно `T-IAM-09`, которое уже соблюдают
`role-assignment.policy.ts`, `permission-override.policy.ts`, `role-composition.policy.ts`,
`invitation-access.policy.ts` и `user-lifecycle.policy.ts` в обе стороны — `ResetUserMfaUseCase` был
единственным путём без него. Добавлена `assertMfaResetInBounds` (`domain/identity/access/mfa-policy.policy.ts`):
читает эффективные права субъекта через `EffectivePermissionsReaderPort` внутри той же транзакции
(идентично `DeactivateUserUseCase`) и отказывает в двух случаях — субъект владелец, а актор нет
(`not_the_owner`, переиспользован из `ownership-transfer.policy.ts`, а не заведён новый) — раньше
правила подмножества, по той же причине, что `assertDeactivable` проверяет конфликт передачи
владения раньше своего подмножества: совет «получите это право» бессмыслен против аккаунта,
держащего все 331 право по построению (`SYSTEM_ROLE_PERMISSIONS.owner`); и субъект держит право,
которого нет у актора (`permission_not_granted`, тот же код и та же форма, что и у
`DeactivateUserUseCase`). Табличные тесты — `test/unit/domain/mfa-policy.test.ts`, use-case и
атакующий сценарий (админ против владельца) — `test/unit/iam/reset-user-mfa.use-case.test.ts` и
`test/integration/http/reset-user-mfa.test.ts`.

**Повтор — настоящий no-op, и лимит частоты (MEDIUM).** До аудита каждый повтор — независимо от
`Idempotency-Key`, который здесь ничего не дедуплицирует (хранилища ответов нет —
`idempotency-key.middleware.ts` прямо называет это открытой половиной, STORY-006-01) —
заново отзывал сессии, поднимал версию прав и слал письмо, даже когда второй фактор уже был выключен:
держатель права в цикле не давал жертве удержать сессию и заливал её почту. `enrollment.disable`
отвечает, было ли 2FA реально включено мгновением раньше (её собственный контракт прямо называет эту
ошибку), и `reset` останавливается на `false` до какой-либо ещё записи — ни кодов, ни сессий, ни
версии, ни письма.

> **Поправка 2026-08-28 (`37e7385`): запись аудита в этот список не входит.** Исходно ветка была
> полностью молчаливой, зеркалом `alreadyDeactivated` у `DeactivateUserUseCase`, — и это оказалось
> ошибкой. Молчание оправдано у деактивации, потому что факт, который она бы записала (`status`),
> и так виден любому, кто может её вызвать, через справочник; у 2FA такой поверхности нет — ни один
> сериализатор не отдаёт чужой `totpEnabled`, а ответ этой операции **сам является** этим фактом для
> держателя `user:reset_mfa`. Молчаливая ветка превращала его в бесплатный оракул: право позволяло
> перебрать коллег и узнать, у кого второй фактор включён, не оставив нигде ни строки. Теперь запись
> пишется **всегда**, `before.totpEnabled` фиксирует ответ `wasEnabled`; на `wasEnabled` гейтится
> только письмо, так что защита от рассылки в цикле, ради которой абзац выше и написан, сохранена
> целиком. Доказано `packages/server/test/unit/iam/reset-user-mfa.use-case.test.ts:260`. Отдельно заведён бюджет `mfa_admin_reset_attempt` (5 / 15 мин, без эскалации,
ключ — актор) — свой, а не доля `mfa_reauth_attempt`: тот бюджет про переаутентификацию вызывающего,
а административный сброс сознательно пропускает пароль и код (в этом весь смысл операции). Тратится
до открытия транзакции, как и у любого чувствительного пути (`rules/security.mdc`, правило 11).

### `session_revoked_reason` получил седьмое значение, а не переиспользовал `OFFBOARDING`

`OFFBOARDING` документирован как «аккаунт перестал быть способен держать сессии» — после
административного сброса 2FA аккаунт остаётся `ACTIVE` и может открыть новую сессию немедленно.
Переиспользование `OFFBOARDING` сделало бы этот комментарий ложным для класса строк, который он не
описывает, поэтому заведено `MFA_RESET_BY_ADMIN` аддитивной миграцией
(`20260812110000_mfa_reset_session_reason`, `ALTER TYPE ... ADD VALUE`, проверено на реальном
Postgres через `pnpm test:integration:local`).

### Самому себе — нельзя, и это конфликт, а не отказ в доступе

`assertNotSelfReset` (домен, чистая функция, без I/O) бросает `ConflictError('self_lockout', …)` —
тот же код, что `assertDeactivable` использует для «нельзя офбордить себя», по идентичной причине:
право `user:reset_mfa` реально есть, объект реально существует, отказывает именно состояние запроса
(«целится в себя»), а не отсутствие права.

### 403 без права — целиком существующий механизм

Критерий 6 («403 без `user:reset_mfa`») не потребовал ни кода, ни строки нового кода: маршрут
объявлен с `permission: 'user:reset_mfa'`, и `require-permission.middleware.ts` уже отвечает
`user_forbidden` с `reason: permission_not_granted` для любого маршрута без объявленного права —
писать для этого специальный код `permission_not_granted` (как буквально сформулирован критерий в
истории) означало бы завести второй код для факта, для которого он уже есть.

## Что отложено, и почему

- ~~**Критерии 4 и 8 (политика организации) — не начаты вовсе, заглушек нет.**~~ **Оба закрыты**:
  критерий 4 — `abe2135` (2026-09-06), критерий 8 — дельтой экрана принудительной настройки
  (2026-09-06). Абзац оставлен зачёркнутым, потому что его рассуждение всё ещё объясняет, почему
  заглушки не заводили: без строки политики в БД `assertNotRequiredByPolicy` нечего было бы читать,
  а код отказа `mfa_required_by_policy`, который никто не бросает, этот эпик уже дважды получал
  находкой на гейте.

  Как выглядят оба сегодня. **Критерий 4:** отказ живёт не в `mfa-policy.policy.ts`, а в
  `DisableTotpUseCase` — он спрашивает `policies.gateFor` и на `covered` бросает
  `MfaRequiredByPolicyError` (`disable-totp.use-case.ts:243`); само правило — чистая
  `evaluateMfaRequirement` в **той же** директории `domain/identity/access/`
  (`mfa-requirement.policy.ts`). Граница проходит не между `domain` и остальным, а по тому, что
  правилу нужно **подать**: `assertNotSelfReset` хватает двух идентификаторов, а вердикту нужны
  настройки организации и неистёкшие назначения ролей — их читает use-case через `policies.gateFor`.
  Проверено блоком «the organization policy» в
  `test/unit/application/disable-totp.use-case.test.ts`. **Критерий 8:** после административного
  сброса все сессии отозваны, следующий вход выдаёт токен со `scope = mfa_enrollment`, и клиент
  уводит такую сессию на `/mfa-enrolment` гардом `requireFullSession` на ветке `_authenticated` —
  состав и проверки в [STORY-013-05](story-013-05-org-2fa-policy.md).
- **Критерий 10 закрыт целиком — отложенного клиента здесь больше нет.** На момент серверной дельты
  клиента не было вовсе: она трогала только `packages/server/**` и смежную документацию. Обе
  половины отгружены следом — **самостоятельное** отключение на `/settings/security`
  (`widgets/disable-totp/`, `units/auth/service/mutations/disable-totp.mutation.ts`, i18n
  `shared/i18n/locales/{en,ru}/security.json`) и **административный** сброс на карточке сотрудника
  (`a5bf8b3`: `widgets/reset-mfa/` под `can('user:reset_mfa')`,
  `units/employee/service/hooks/use-reset-mfa.hook.ts`, чтение `ResetMfaResult` со счётчиками в
  отчёте диалога). Операторский путь по
  [`docs/runbooks/incident.md`](../../../docs/runbooks/incident.md) остаётся запасным, а не
  единственным.
- **`test:integration:local` для recovery-кода в `disable` отдельным гонка-тестом не написан.**
  Атомарность списания уже доказана на реальном Postgres для той же операции
  (`RecoveryCodeRepositoryPort.markUsed`) в `test/integration/db/mfa-recovery-code-race.test.ts`
  (STORY-013-02); `DisableTotpUseCase` вызывает тот же метод через тот же `RecoveryCodeMatcher`, а не
  собственную реализацию, поэтому отдельное гоночное доказательство для него измеряло бы то же самое
  свойство того же SQL-оператора во второй раз.

## Блокирующая зависимость эпика — снята 2026-08-12

[`epic.md`](../epic.md), раздел «Блокирующая зависимость внутри эпика»: механизм выхода из 2FA,
которого не хватало для снятия `blocked: true` с STORY-013-03, существует и протестирован —
самостоятельное отключение (`POST /auth/2fa/disable`) и административный сброс
(`POST /users/{userId}/reset-mfa`) оба реализованы, покрыты юнит- и HTTP-интеграционными тестами,
включая настоящий отзыв сессии на реальном refresh-cookie.

Серверная дельта этой истории пометку сознательно **не трогала**: формулировка эпика звучала
«снимается пометка выпуском STORY-013-04», а история не в `done` — клиентской половины тогда не было
вовсе, и решение оставили тому, кто возьмёт STORY-013-03 или закроет клиент здесь. Оно принято
следом: экран `/settings/security` с самостоятельным отключением отгружен, значит человек с
аутентификатором на руках выходит из 2FA кнопкой, а не вызовом API, — и `blocked: true` с
[story-013-03-login-second-factor.md](story-013-03-login-second-factor.md) снят, а сама история взята
в работу и её серверная половина отгружена. Последний остаток критерия 10 — экран
административного сброса — закрыт 2026-08-14 (`a5bf8b3`), см. «Что отложено».

## Ссылки

- [`threat-model.md`, `T-IAM-04`, `T-IAM-01`, `T-IAM-06`](../../../docs/security/threat-model.md)
- [`permission-model.md` §3.2 (`user:reset_mfa` — `dangerous`), §4.1](../../../docs/security/permission-model.md)
- [`permission-model.md` §10 «Аудит», отказы по опасным правам](../../../docs/security/permission-model.md)
- [`ux-architecture.md`, `/settings/security`, «Подтверждение разрушающих действий»](../../../docs/architecture/ux-architecture.md)

## Definition of Done

- [x] Тесты написаны первыми (TDD), проходят, изменённый код покрыт. Числа здесь не записаны
      намеренно — их печатает `pnpm turbo run test`, и записанные однажды они устаревают на
      следующем коммите (CLAUDE.md, «Числа по артефактам»). Интеграционный набор с реальным
      Postgres зелёный (кроме одного воспроизводимо не связанного с этой дельтой Docker-флейка в
      `rate-limit/shared-counter.test.ts`, подтверждённого зелёным при изолированном перезапуске)
- [x] Commit-гейт прогнан 2026-08-27 по всей ветке (восемь агентов). PASS сразу:
      `test-coverage`, `security-auditor`, `commit-hygiene`, `openapi-contract-guardian`.
      Четыре FAIL закрыты 2026-08-28: `i18n-coverage-checker` — гейт `plural.test.ts` написан
      (`354e880`); `fsd-architecture-linter` — девять экранов сведены к цепочке через unit-хуки и
      заведён архитектурный гейт (`2c5540e`); `stale-claims-auditor` — утверждения выправлены
      (`a8b63dd`, `7b60154` и эта правка); `production-readiness` — CHANGELOG дополнен
      обязательным шагом обновления и разделом «Not yet present» (`a8b63dd`).
      typecheck/lint/build/test и `pnpm coverage:baseline` — зелёные
- [x] Документация обновлена (`openapi.yaml`, `docs/runbooks/incident.md` — оговорка о ручном сбросе
      снята — + эта запись истории; записи в `docs/brain/`:
      `2026-08-12--two-exits-from-the-locked-door.md`, `2026-08-13--the-table-that-was-green-without-the-check.md`,
      `2026-08-15--eight-gates-and-two-journals-that-expired.md`)
- [x] a11y и i18n — клиент в зоне с тех пор, как отгружены оба экрана: ключи
      `security.disable.*` и `security.reset.*` есть в EN и RU
      (`shared/i18n/locales/{en,ru}/security.json`), axe прогоняется по обеим граням диалогов
      (`packages/client/test/widgets/disable-totp.test.tsx`, `.../reset-mfa.test.tsx`), ловушка
      фокуса обеих модалок — в реестре `test/architecture/modal-focus-coverage.test.ts`
- [x] **Isolation-тест RLS** — новых таблиц нет; изменение схемы (новое значение перечисления) не
      таблица и не требует отдельного isolation-теста
- [x] **Permission объявлена** — `user:reset_mfa` уже существовала в каталоге
      (`permissions.catalog.ts`, `dangerous: true`) до этой истории; `2fa/disable` — self-service с
      обоснованием в реестре и в `x-self-service-reason` спеки
