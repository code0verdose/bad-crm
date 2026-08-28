---
id: STORY-013-01
epic: EPIC-013
status: in-progress
blocked: false
priority: must
estimate: M
---

# STORY-013-01 — Включение TOTP по QR-коду

**Как** сотрудник **я хочу** привязать приложение-аутентификатор, отсканировав QR-код и подтвердив
владение одним кодом, **чтобы** мой аккаунт нельзя было захватить одним лишь украденным паролем.

## Acceptance (Given/When/Then)

1. **Инициация привязки.**
   Given аутентифицированный пользователь без включённой 2FA;
   When `POST /api/v1/auth/2fa/setup`;
   Then сервер генерирует секрет (base32, ≥ 160 бит энтропии) и возвращает **один раз**
   `otpauth://totp/BadCRM:{email}?secret=…&issuer=BadCRM&algorithm=SHA1&digits=6&period=30`
   плюс SVG QR-кода; секрет сохраняется как **черновой** (`totpSecretEnc` заполнен,
   `totpEnabledAt = null`), поэтому 2FA ещё не действует.

2. **Подтверждение владения.**
   Given черновой секрет, код из аутентификатора и текущий пароль;
   When `POST /api/v1/auth/2fa/confirm` с `{ code, currentPassword }` (пароль обязателен: включение —
   чувствительное действие над учётной записью, наличия сессии для него недостаточно, `T-IAM-01`);
   Then при совпадении **обоих** факторов проставляется `totpEnabledAt = now`, генерируются коды восстановления
   ([STORY-013-02](story-013-02-recovery-codes.md)), в `AuditLog` — `user.mfa_enabled`
   (`severity = warning`); ответ 200.

3. **Негативный сценарий — без подтверждения 2FA не включена.**
   Given пользователь получил QR, но код не ввёл;
   When он выходит и логинится снова;
   Then второй фактор не спрашивается, черновой секрет истекает через 15 минут и удаляется джобом;
   повторный `setup` выдаёт **новый** секрет (старый инвалидируется).

4. **Негативный сценарий — неверный код.**
   Given введён код с ошибкой;
   When приходит `confirm`;
   Then 422 `invalid_totp_code` без раскрытия, «насколько» код неверен; после 5 неудач подряд —
   429 с экспоненциальной задержкой, черновой секрет аннулируется, событие в `AuditLog`.

5. **Окно дрейфа часов зафиксировано.**
   Given часы клиента отстают на 25 секунд;
   When код проверяется;
   Then он принимается (`window = 1`, то есть ±1 шаг по 30 c); код, отстающий на 90 секунд,
   отклоняется — граница покрыта тестом с фиксированным `ClockPort`.

6. **Одноразовость кода внутри окна.**
   Given код `123456` только что успешно использован;
   When тот же код предъявляется повторно в пределах того же 30-секундного шага;
   Then 422 `totp_code_replayed`: последний принятый `counter` сохраняется и сравнивается
   (защита от подсматривания через плечо и от replay).

7. **Негативный сценарий — секрет не покидает сервер повторно.**
   Given 2FA уже включена;
   When вызывается `setup` ещё раз;
   Then 409 `mfa_already_enabled`; секрет невозможно прочитать через API ни при каких условиях;
   grep-тест по e2e-логам не находит base32-секрета.

8. **Секрет зашифрован в БД.**
   Given запись `users`;
   When она читается напрямую из БД;
   Then `totp_secret_enc` — шифротекст с префиксом версии ключа (`v1:`), `APP_ENCRYPTION_KEY`
   ровно 32 байта base64; plaintext-колонки не существует (структурный тест схемы).

9. **Кросс-тенантность и подделка субъекта.**
   Given тело запроса содержит `userId`;
   When запрос обрабатывается;
   Then поле игнорируется — актор берётся из `AsyncLocalStorage`-контекста сессии (`.strict()`-схема).

10. **a11y и i18n.**
    Given экран `/settings/security`;
    When он проверяется axe и с клавиатуры;
    Then 0 нарушений A/AA, секрет доступен как текст для ручного ввода (не только QR), поле кода
    имеет `inputmode="numeric"` и `autocomplete="one-time-code"`, все строки — EN и RU.

## Задачи

- [x] `packages/server/src/application/identity/use-cases/setup-totp.use-case.ts`,
      `confirm-totp.use-case.ts`.
- [x] `packages/server/src/application/identity/ports/totp.port.ts` +
      `infrastructure/crypto/otplib-totp.adapter.ts` (`otplib` v13, `window: 1`, `digits: 6`,
      `period: 30`).
- [x] `packages/server/src/application/identity/ports/qr-code.port.ts` +
      `infrastructure/qr/qrcode-svg.adapter.ts` — SVG QR-кода из `otpauth://`-URI (в исходной
      формулировке задачи отсутствовал, хотя критерий 1 его требует).
- [x] `packages/server/src/infrastructure/crypto/field-encryption.adapter.ts` — шифрование
      `totpSecretEnc` с префиксом версии ключа. **Существующий адаптер переиспользован** без правок:
      формат `v1:<iv>:<tag>:<ciphertext>` уже был контрактом порта.
- [x] `packages/server/prisma/migrations/20260811090000_totp_enrollment_columns/migration.sql` —
      `users.totp_last_counter`, `totp_draft_expires_at`. `totp_secret_enc` и `totp_enabled_at`
      **уже существовали** с `20260728120000_auth_core_identity_and_sessions`.
- [x] `packages/server/src/presentation/http/route-registry.factory.ts` — маршруты `2fa/setup`,
      `2fa/confirm` (требуют сессии; `permission` не нужен — операция над собой, обоснование записано
      как `x-self-service-reason` в спеке и текстом в реестре).
- [x] Ограничитель частоты — не отдельный файл, а политика `mfa_setup_attempt` в
      `infrastructure/rate-limit/rate-limit-policy.constant.ts` поверх существующего Redis-лимитера
      (5 / 15 минут, эскалация ×2 до часа).
- [x] `packages/client/src/units/auth/service/{mutations,hooks}` — `setup-totp.mutation.ts`,
      `confirm-totp.mutation.ts`; хук назван `use-totp-enrolment.hook.ts`, а не `use-totp-setup`.
- [x] `packages/client/src/widgets/totp-setup/totp-setup.widget.tsx` + `ui/totp-lockout-warnings`;
      `totp-qr.component.tsx` и `totp-code-field.component.tsx` живут в `units/auth/ui/`, а не в
      виджете — они доменные, а виджет их только композирует. Что смонтировано на экране сегодня:
      `grep -n '@widgets/' packages/client/src/pages/settings-security/page.tsx`.
- [x] i18n: `packages/client/src/shared/i18n/locales/{en,ru}/security.json` — namespace заведён в
      обоих языках; паритет держит `test/i18n/`, состав ключей печатает
      `python3 -c "import json;print(*sorted(json.load(open('packages/client/src/shared/i18n/locales/en/security.json'))))"`.
- [x] Тесты: `test/unit/crypto/otplib-totp.adapter.test.ts` (в том числе пара «25 c принимается /
      90 c отклоняется»), `test/unit/application/{setup-totp,confirm-totp}.use-case.test.ts`
      (п. 4–6 с фиксированным `ClockPort`), `test/unit/qr/qrcode-svg.adapter.test.ts`,
      `test/integration/http/mfa-endpoints.test.ts`.
- [x] Структурный тест схемы и негативный контроль логов —
      `test/unit/persistence/mfa-recovery-code-structure.test.ts`: `totpSecretEnc` обязан быть,
      `totpSecret`/`totpSecretPlain`/`totpBase32Secret` обязаны отсутствовать, а `base32Secret`,
      `secretEnc` и `recoveryCodes` обязаны стоять в `REDACTED_PATHS`.
- [x] E2E: `packages/e2e/tests/auth/enable-2fa.spec.ts`, axe в каждой фазе сценария. Сколько его
      вызовов закоммичено — `grep -c 'audit(page)' packages/e2e/tests/auth/enable-2fa.spec.ts`.

## Ссылки

- [`threat-model.md`, `T-IAM-04`, `T-IAM-08`, `T-SH-04`](../../../docs/security/threat-model.md)
- [`data-model.md`, группа 1, `User.totpSecretEnc`, `totpEnabledAt`](../../../docs/architecture/data-model.md)
- [`stack.md`, `otplib`, «Безопасность в коде»](../../../docs/architecture/stack.md)
- [`ux-architecture.md`, `/settings/security`, «Формы»](../../../docs/architecture/ux-architecture.md)
- PRD: NFR-6

## Сделано (2026-08-12) — серверная половина

### Черновик — состояние строки, а не флаг в коде

`beginDraft` это `UPDATE users SET totp_secret_enc = …, totp_draft_expires_at = … WHERE
totp_enabled_at IS NULL`. Прочитать состояние и разветвиться на нём значило бы оставить окно, в
котором параллельный `confirm` включает 2FA, а этот вызов молча заменяет уже отсканированный секрет
новым, которого нет ни в одном аутентификаторе. Условная запись это окно закрывает: чей `UPDATE`
дошёл до PostgreSQL после включения, тот не находит строки и получает `409 mfa_already_enabled`
(критерий 7). Существующий секрет ради этого ответа **не читается** — ни разу, ни для сравнения.

### Ничего нового для шифрования и для хеширования

Секрет уходит в `FieldEncryptionPort.encrypt` — тот самый адаптер, под которым уже лежат ключи
AI-провайдеров и экстренный контакт сотрудника (`v1:<iv>:<tag>:<ciphertext>`, AES-256-GCM,
`APP_ENCRYPTION_KEY`). Второй механизм шифрования «для 2FA» не заведён сознательно: у ротации ключа
одна процедура, у формата один парсер, и версия ключа читается тем же префиксом. Расшифровка живёт
ровно на длину одной проверки в `ConfirmTotpUseCase` и не кладётся в поле класса.

### Бюджет тратится до того, как код прочитан

`mfa_setup_attempt.consume` вызывается **первой строкой** `execute`, как `LoginUseCase` тратит
`auth_attempt` до Argon2id: всё, что происходит после ответа лимитера, не должно быть достижимо тем,
кто бюджет уже израсходовал.

Из этого порядка следует число, которого нет в критерии 4 прямым текстом: попытки 1–5 обрабатываются
штатно, а черновик выбрасывается на **шестом** запросе — вместе с 429. `consume` на шестом отвечает
`allowed: false`, и только тогда `abandonDraft` и запись `user.mfa_setup_failed` уходят одной
транзакцией. Формулировка спеки `openapi.yaml` («The fifth refusal discards the draft») этому не
соответствовала и **исправлена вслед за кодом**; текст истории коду соответствовал.

### Окно дрейфа

`epochTolerance = TOTP_DRIFT_WINDOW_STEPS × TOTP_STEP_SECONDS` — одно умножение в адаптере вместо
пересчёта на каждом вызове. Граница критерия 5 закреплена парой «25 секунд принимается / 90 секунд
отклоняется» в `otplib-totp.adapter.test.ts`.

### Одноразовость кода внутри окна — сделана, и отвечает своим кодом

`totp_last_counter` пишется вместе с включением (`commitEnrollment`) и передаётся в проверку как
`afterTimeStep`, так что предъявленный второй раз код в том же шаге не принимается (критерий 6).
Повтор при этом отличается от просто неверного кода: адаптер возвращает флаг `replayed`, и
`confirm-totp.use-case.ts:249` бросает `TotpCodeReplayedError` вместо `InvalidTotpCodeError`
(покрыто `test/unit/application/confirm-totp.use-case.test.ts:225-241`). Критерий 6 закрыт целиком.

### Включение требует пароля, а не только сессии

`POST /auth/2fa/confirm` принимает `{ code, currentPassword }`
(`presentation/http/validators/mfa.validator.ts:35-38`). Пароль проверяется **всегда** — вместе с
чтением черновика, а не после успешной проверки кода (`confirm-totp.use-case.ts:210`), — поэтому по
ответу нельзя понять, какая из двух проверок не прошла: неверный пароль даёт
`403 reauthentication_required` независимо от того, верен ли код
(`confirm-totp.use-case.ts:247,252-255`). Держателя одной лишь угнанной сессии этого барьера
достаточно, чтобы отвергнуть (`T-IAM-01`). Спека приведена в соответствие: `ConfirmTotpRequest`
объявляет оба поля обязательными.

### Актор — из сессии, не из тела

`confirmTotpBodySchema` это `z.strictObject({ code, currentPassword })`: `userId` не просто
игнорируется — тело с лишним полем отвергается 422 (критерий 9). Ни одна схема этой поверхности поля
`userId` не имеет.

## Что отложено, и почему

- ~~**Весь клиент (критерий 10)**~~ — **закрыто (2026-08-12, `430457e`; e2e — `487383e`).** Здесь
  было записано, что экрана `/settings/security` не существует и потому не сделано ничего из
  критерия. Экран есть: маршрут `app/routes/_authenticated/settings/security.tsx`, композиция
  `pages/settings-security/page.tsx`, виджеты `totp-setup`, `recovery-codes` и `disable-totp` на нём
  смонтированы. Секрет показан текстом рядом с QR (`units/auth/ui/totp-qr.component.tsx`), поле кода
  несёт `inputmode="numeric"` и `autocomplete="one-time-code"`
  (`units/auth/ui/totp-code-field.component.tsx`), axe гоняется в `enable-2fa.spec.ts`, namespace
  `security.json` заведён в EN и RU. Как и предполагалось, экран собрался вместе с виджетами
  [STORY-013-02](story-013-02-recovery-codes.md) и [STORY-013-04](story-013-04-disable-totp.md) —
  они живут на том же маршруте.
- **Джоба подчистки просроченных черновиков (критерий 3)** — планировщика в сборке нет: ни таблицы
  `outbox_event`, ни воркера BullMQ (ADR-0021 принят, механизм не реализован — тот же долг записан в
  STORY-012-05 и STORY-012-06). Смягчение, из-за которого это не дыра: просроченный черновик
  **отвергается на чтении** — `ConfirmTotpUseCase` требует `draftExpiresAt > now` и отвечает
  `invalid_totp_code`, а повторный `setup` перезаписывает строку. То есть в таблице копится мусор, а
  не пригодный к подтверждению секрет. Владельца-истории у сметания этого мусора сегодня нет; оно
  возвращается вместе с самим механизмом очереди.
- ~~**Отдельный код отказа `totp_code_replayed` (критерий 6)**~~ — **закрыто (2026-08-12).** Ранее
  здесь было записано, что `TotpCodeReplayedError` заведён, опубликован в `ErrorCode` и переведён, но
  «не бросается ниоткуда». Это больше не так: `confirm-totp.use-case.ts:249` бросает его на флаге
  `replayed` из адаптера, тест — `confirm-totp.use-case.test.ts:225-241`.

  > **Поправка 2026-08-28 (`c5a50b6`, 2026-08-13).** Ниже здесь стояло, что опубликованным кодом
  > отказа без источника остаётся `recovery_code_invalid`, потому что `ConsumeRecoveryCodeUseCase`
  > не подключён. Это больше не так: [STORY-013-03](story-013-03-login-second-factor.md) вышла,
  > `POST /auth/2fa/verify` стоит в реестре маршрутов, use-case собран в `container.factory.ts`, а
  > сам код отказа больше не отдельный компонент спеки — он один из кодов, описанных в
  > `SecondFactorRefused`, на который этот маршрут и ссылается. Кодов отказа без источника в этой
  > дельте не осталось.
- ~~**Grep-тест e2e-логов на base32-секрет (критерий 7)**~~ — **закрыто (2026-08-12, `430457e`).**
  Записано было, что греп по логам несуществующего прогона проверял бы пустоту. Утверждение
  переехало туда, где оно доказуемо без прогона:
  `test/unit/persistence/mfa-recovery-code-structure.test.ts` требует, чтобы `base32Secret`,
  `secretEnc` и `recoveryCodes` стояли в `REDACTED_PATHS` — и на верхнем уровне, и как `*.<имя>`.
  Греп по выводу ловил бы утечку только на том пути, который сценарий случайно прошёл; список
  редакции — это то, на что опираются `SetupTotpUseCase`, `ConfirmTotpUseCase` и
  `RegenerateRecoveryCodesUseCase`, сами его не перепроверяя.
- ~~**Структурный тест схемы «plaintext-колонки не существует» (критерий 8)**~~ — **закрыто
  (2026-08-12, `430457e`).** Тот же файл, блок «the TOTP secret column stays encrypted-only»:
  `totpSecretEnc` обязан присутствовать в `model User`, а `totpSecret`, `totpSecretPlain` и
  `totpBase32Secret` — отсутствовать. Читается сам `schema.prisma`, а не поведение дубля: у
  поддельного репозитория нет схемы, которую можно нарушить.

## Блокирующая зависимость, созданная этой историей — снята

Здесь было записано: **включение 2FA доступно по API, а выхода из неё нет** — ни отключения, ни
административного сброса, ни CLI, а перевыпуск набора требует живого TOTP-кода, то есть набор не
умеет продлевать сам себя. Отсюда выводилось условие, что
[STORY-013-03](story-013-03-login-second-factor.md) не выходит раньше
[STORY-013-04](story-013-04-disable-totp.md).

> **Поправка 2026-08-28: условие выполнено, а не отменено (`1e51d69`, 2026-08-12; UI — `0c889f9`
> и `a5bf8b3`, 2026-08-14).** Обе истории в `review`, и порядок был соблюдён: выход появился
> раньше входа. `POST /auth/2fa/disable` требует пароль и второй фактор, `POST
> /users/{userId}/reset-mfa` даёт административный сброс, и у обоих есть интерфейс —
> `widgets/disable-totp` на `/settings/security`, `widgets/reset-mfa` на карточке сотрудника
> (`pages/employee-profile/page.tsx`). Актуальный состав маршрутов:
> `grep -n '2fa/\|reset-mfa' packages/server/src/presentation/http/route-registry.factory.ts`.

Опора зависимости — «потеря аутентификатора необратима» — вместе с этим отпала. Сотрудник,
потерявший телефон, восстанавливается административным сбросом. Необратимым остаётся ровно один
случай, и он не про механизм: **единственный владелец организации, потерявший и телефон, и коды**, —
сбросить его второй фактор по-прежнему некому, потому что права на сброс никто выше него не держит.
Это остаточный риск продукта, а не незакрытая работа этой истории.

### Переаутентификация на включении — закрыто (2026-08-12), опора отпала

Раньше здесь стояла вторая опора той же зависимости: ни `setup`, ни `confirm` не спрашивают пароля,
поэтому нарушитель с угнанным access-токеном привязывает свой аутентификатор и делает захват учётной
записи неотменяемым. **Эта половина дыры закрыта.** `confirm` требует `currentPassword` наравне с
`code`, пароль проверяется всегда, неверный пароль отвечает `403 reauthentication_required`
независимо от кода — см. раздел «Включение требует пароля, а не только сессии» выше; спека
(`ConfirmTotpRequest`) объявляет оба поля обязательными. Правило STORY-013-04, критерий 3 («наличие
сессии само по себе недостаточно», `T-IAM-01`), написанное про `disable`, теперь применено и к
включению — на том же уровне, что у соседнего
`POST /auth/2fa/recovery-codes/regenerate` ([STORY-013-02](story-013-02-recovery-codes.md)).

Session-only остался только `setup`, и это безвредно: он готовит **черновик**, который ничего не даёт
до подтверждения, отвергается на чтении по истечении и уничтожается при исчерпании попыток.

Формально критерия на переаутентификацию у этой истории по-прежнему нет — поведение отгружено
раньше, чем описано. Критерий 2 приведён в соответствие с кодом выше по тексту; заводить отдельный
критерий при доработке уже не нужно, нужно не потерять его при переписывании.

> **Поправка 2026-08-28.** Здесь стояло: «блокирующая зависимость от этого не снимается — она стоит
> на отсутствии выхода; сегодня это не взорвалось только потому, что вход второй фактор не читает
> вовсе». Обе половины устарели. Вход второй фактор читает
> ([STORY-013-03](story-013-03-login-second-factor.md), `c5a50b6`), а выход появился раньше него
> ([STORY-013-04](story-013-04-disable-totp.md), `1e51d69`) — зависимость снята выполнением, см.
> раздел «Блокирующая зависимость, созданная этой историей — снята».

### `Idempotency-Key` требуется, а стора нет — и здесь это уже не «неудобство»

`POST /auth/2fa/confirm` обязан нести `Idempotency-Key`
(`presentation/http/middleware/idempotency-key.middleware.ts`), но хранилища ответов в продукте нет:
middleware проверяет форму заголовка и пропускает запрос дальше. Комментарий middleware обосновывает
это тем, что без стора теряется «удобство, а не безопасность» — на `POST /auth/register` это верно,
потому что повтор упирается в уникальный `organizations.slug`.

**Для `confirm` рассуждение не работает.** Ответ на успешное включение несёт единственную копию
десяти кодов восстановления; в базе — только argon2id-хеши. Потерянный по сети ответ (таймаут,
разрыв, закрытая вкладка) означает, что 2FA **включена**, а кодов человек **не увидел** и увидеть
уже не может: повтор запроса упрётся в `invalid_totp_code`, потому что черновика больше нет.
Уникального ограничения, которое сделало бы повтор безопасно-эквивалентным, здесь не существует.

Выход есть и он единственный — **перевыпуск набора**
(`POST /auth/2fa/recovery-codes/regenerate`): он требует пароль и живой TOTP-код, а оба у человека,
который только что завершил привязку, на руках. Это записано в описание операции в
[`openapi.yaml`](../../../docs/api/openapi.yaml), чтобы клиент знал, куда вести пользователя, а не
показывал общую ошибку сети. Полноценная идемпотентность — сквозной механизм (стор по паре
`(key, request hash)`), она за пределами этого эпика; долг записан в STORY-006-01.

## Definition of Done

- [x] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [x] Commit-гейт зелёный — FAIL волны 2026-08-12 закрыты 2026-08-28 (`354e880`, `2c5540e`,
      `a8b63dd`, `7b60154`, `f17e652`)
- [x] Документация обновлена (`openapi.yaml`, `data-model.md`, CHANGELOG + запись в `docs/brain/`)
- [x] a11y и i18n — экран `/settings/security` есть, axe гоняется в `enable-2fa.spec.ts`, namespace
      `security.json` заведён в EN и RU наравне
- [x] **Isolation-тест RLS** — новых таблиц у этой истории нет, добавлены две колонки в `users`,
      уже покрытые реестровым набором `rls-isolation.test.ts`
- [x] **Permission объявлена** — обе записи реестра self-service, обоснование записано в реестре и в
      `x-self-service-reason` спеки; актор берётся из сессии, не из тела
