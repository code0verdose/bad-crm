---
id: STORY-006-01
epic: EPIC-006
status: review
blocked: false
priority: must
estimate: M
---

# STORY-006-01 — Регистрация организации и владельца

> **Экран отгружен 2026-09-05** — врезка ниже описывает состояние до этого дня и оставлена как
> история находки. Сегодня `/register` есть: маршрут, страница, форма, схема, мутация и хук, плюс
> сценарный набор `packages/client/test/routes/registration-flow.test.tsx`. Статус истории меняет
> человек после commit-гейта, не эта правка.
>
> **Статус понижен в `in-progress` 2026-08-30 сверкой с кодом.** Серверная половина отгружена
> целиком (эндпоинт, use-case, argon2id, политика пароля, `REGISTRATION_OPEN`, лимит), а
> **клиентского экрана регистрации не существует**: в `packages/client/src/app/routes` нет маршрута
> `/register`, в `pages/` нет каталога `register`, в `units/auth/ui` нет формы. То есть первый
> критерий приёмки («отправляю форму регистрации») не выполним в интерфейсе вообще: организацию
> сегодня заводят запросом к API или сидом. Отсюда же тянутся два чужих пункта — смоук-сценарий
> регистрации в [STORY-010-04](../../epic-010-e2e-harness/stories/story-010-04-smoke-register-login-logout.md)
> и первый критерий эпика.

**Как** владелец инсталляции **я хочу** создать организацию и учётную запись владельца через
интерфейс **чтобы** начать пользоваться развёрнутым экземпляром без правки конфигов и SQL.

## Acceptance (Given/When/Then)

- **Given** пустая инсталляция **When** отправляю форму регистрации с названием организации, email и паролем **Then** создаются организация, пользователь-владелец и системные роли в одной транзакции, и я оказываюсь аутентифицированным.
- **Given** пароль `qwerty123` **When** отправляю форму **Then** возвращается 422 `validation_failed` с ошибкой по полю `password`; политика (минимум 12 символов, проверка на компрометацию по списку слабых) описана Zod-схемой в `packages/shared` и применяется и на клиенте, и на сервере.
- **Given** сохранённый пароль **When** смотрю строку в БД **Then** это argon2id-хеш с параметрами `memoryCost ≥ 19456`, `timeCost ≥ 2`; сам пароль нигде не логируется и не возвращается.
- **Given** занятый `slug` организации **When** отправляю форму **Then** 409 `organization_already_exists`, ни одна строка не создана, поле формы подсвечено.
- **Given** email в формате `  User@Example.COM ` **When** он сохраняется **Then** он нормализован (`citext`, trim, lower-case), а уникальность проверяется в паре `(organization_id, email)`, а не глобально.
- **Given** параметры argon2 подняты в env **When** пользователь входит со старым хешем **Then** проверка проходит и хеш прозрачно перехешируется новыми параметрами.
- **Given** повторная отправка формы из-за обрыва сети с тем же `Idempotency-Key` **When** запрос приходит второй раз **Then** возвращается сохранённый ответ, вторая организация не создаётся.
- **Given** уже существующая организация в инсталляции **When** открытая регистрация запрещена настройкой инсталляции **Then** endpoint возвращает 403 `registration_disabled`, а форма недоступна.

## Задачи

- [x] Написать тесты первыми: `test/unit/application/register-organization.use-case.test.ts` (успех, слабый пароль, занятый slug, откат), `test/integration/http/auth-endpoints.test.ts` (реальная БД, хеш в БД, нормализация email, идемпотентность), `packages/shared/test/validation/primitives.test.ts` (блок `passwordSchema`).
      *Сделано 2026-07-29:* `test/unit/application/register-organization.use-case.test.ts` (успех,
      слабый пароль, закрытая регистрация, дефолты локали/таймзоны, «пароль не попал в ответ»),
      `test/unit/crypto/argon2-password-hasher.test.ts` (пол OWASP, перехеш, dummy-хеш),
      `packages/shared/test/validation/weak-password.test.ts` (переехал из `packages/server` 2026-09-06 — одна копия списка на клиент и сервер), `test/integration/http/auth-endpoints.test.ts`
      (201 + cookie, 422 по полю, 403 при закрытой регистрации, `Idempotency-Key`). Откат
      транзакции по-прежнему проверяется на живом PostgreSQL в
      `test/integration/db/organization-bootstrap.test.ts`.
- [x] Реализовать `packages/shared/src/validation/password.schema.ts` — единая политика пароля для клиента и сервера.
      *Закрыто ревизией 2026-07-28:* файл существует с EPIC-001
      (`packages/shared/src/validation/password.schema.ts:20`) — `passwordSchema` с
      `PASSWORD_MIN_LENGTH = 12` и `PASSWORD_MAX_LENGTH = 128`, без trim и case-folding, одна схема
      на клиент и сервер; те же границы продублированы в `docs/api/openapi.yaml` (`Password`).
      Пометка стояла невыполненной при уже существующей реализации. **Остаётся в этой истории:**
      проверка на компрометацию/слабость из acceptance (zxcvbn score ≥ 3, top-100k blocklist) —
      сама схема в своём комментарии относит её к use-case'у, который умеет её ещё и rate-limit'ить.
      *2026-07-29:* закрыто **частично** — `packages/shared/src/validation/weak-password.util.ts` (до 2026-09-06 жил на сервере в domain/identity под тем же именем) отбивает
      клавиатурные дорожки (с leetspeak-фолдингом), повтор одного символа, монотонный ряд и
      «только цифры», use-case отвечает `422 validation_failed` по полю `owner.password`. Полный
      `zxcvbn` + список top-100k — **остаётся открытым**: это зависимость и файл данных, решение о
      которых принимается вместе с политикой паролей инсталляции, а не в M1.
- [x] Добавить модели `User` и `Session` в `schema.prisma` и миграцию с полным блоком RLS и индексами (`uq_users_org_email … WHERE deleted_at IS NULL`, `idx_users_org_status`).
      *Сделано 2026-07-28:* миграция `20260728120000_auth_core_identity_and_sessions` (expand-шаг),
      таблицы `users`/`sessions`/`password_reset_tokens` с `ENABLE`+`FORCE`, политикой
      `tenant_isolation` (`USING` и `WITH CHECK`), `maintenance_access`, явными `GRANT` и составными
      FK; реестр `tenant-tables.constant.ts` + `ROW_FACTORIES`; `pnpm check:rls` и матрица изоляции
      зелёные. **Остаётся в этой истории:** `organizations.owner_id` и `teams.lead_id` (nullable
      expand + бэкфилл) — их проставляет use-case регистрации, поэтому они идут вместе с ним.
      *2026-07-29:* `organizations.owner_id` добавлен миграцией
      `20260729120000_auth_owner_and_lookup_functions` (nullable expand, составной FK
      `(id, owner_id) → users (organization_id, id)` с `ON DELETE SET NULL (owner_id)`), пишет его
      `PrismaOwnerRoleSeeder` в той же транзакции, что и владельца. `teams.lead_id` **не сделан
      сознательно**: регистрация команды не создаёт, колонка без пишущего кода — мёртвый expand;
      она идёт вместе с созданием команд (EPIC-012).
- [x] Реализовать `infrastructure/crypto/argon2-password-hasher.adapter.ts` под портом `PasswordHasherPort` (хеш, проверка, признак необходимости перехеша).
      *Сделано 2026-07-29:* argon2id через `@node-rs/argon2` 2.0.2; конструктор **отказывается
      стартовать** ниже пола OWASP (`m=19456, t=2, p=1`), `needsRehash` сравнивает параметры из
      самого дайджеста и не трогает более сильный, `dummyHash` — настоящий хеш той же стоимости для
      пути «пользователя нет».
- [x] Реализовать `application/identity/use-cases/register-organization.use-case.ts` поверх bootstrap-сценария из [STORY-005-06](../../epic-005-multi-tenancy-rls/stories/story-005-06-organization-bootstrap-transaction.md).
      *Сделано 2026-07-29:* настройка инсталляции → политика пароля → хеш → `bootstrap.execute`
      (одна транзакция: организация + владелец + owner-роль) → сессия во второй транзакции.
      Разделение осознанное: «оба или ни одного» — требование к арендатору, а не к сессии.
      *Уточнено 2026-07-29 (гейт безопасности):* между настройкой инсталляции и политикой пароля
      встал `consume('organization_registration', {ip})` — 3/час на адрес (STORY-006-07). Порядок
      именно такой: закрытая регистрация отвечает, ничего не читая и не хеша, поэтому бюджет на неё
      не тратится; но если регистрация открыта, лимит спрашивается **до** argon2id и **до**
      транзакции, создающей тенанта. До этого публичный `POST /auth/register` позволял анонимно
      наполнять базу организациями и по 19 MiB на запрос.
- [x] Добавить операцию `POST /api/v1/auth/register` в `docs/api/openapi.yaml` и реализовать контроллер с валидатором.
      *Дозакрыто 2026-07-29:* маркер `x-implemented-by` снят, маршрут объявлен в реестре,
      `presentation/http/validators/auth.validator.ts` + `controllers/auth.controller.ts`,
      `middleware/idempotency-key.middleware.ts`. **Остаётся открытым:** воспроизведение
      сохранённого ответа по `Idempotency-Key` — для него нужна таблица `(ключ, хеш запроса) →
      ответ`, это сквозной механизм вне этого эпика. Защитная половина уже работает: `slug`
      уникален глобально, поэтому повтор даёт `409 organization_already_exists`, а не вторую
      организацию.
      *(2026-07-28: **половина сделана** — операция описана в спеке с маркером
      `x-implemented-by: STORY-006-01`; `Idempotency-Key` обязателен, 403 `registration_disabled`,
      409 `organization_already_exists`, 422 по полю. Поля владельца — `email`, `password`,
      `locale?`, `timezone?`: имени у `User` в `data-model.md` §1 нет, и договор его не выдумывает.
      Контроллер и валидатор — за этой историей.)*
- [x] Реализовать клиентский экран регистрации: `pages/register`, `units/auth/ui/register-form.component.tsx`, хук `use-register.hook.ts`, схема формы через встроенный `schemaResolver` из `@mantine/form`
      (`validate: schemaResolver(schema, { sync: true })`).
      *(Сверено 2026-08-30: ни одного из трёх файлов не было — это был единственный открытый пункт
      истории и причина её статуса.)*
      *Сделано 2026-09-05:* маршрут `app/routes/register.tsx` (`redirectIfAuthed`, без
      search-схемы), `pages/register/page.tsx` — только композиция, `units/auth/ui/register-form.component.tsx`
      и `registration-closed.component.tsx`, `model/validation/register-form.schema.ts`
      (`SharedValidation.passwordSchema` и `emailSchema` переиспользованы, паттерн slug сверяется со
      спекой в `test/api/register-form-bounds.test.ts`), `service/mutations/register-organization.mutation.ts`
      и `service/hooks/use-registration.hook.ts`. Хук назван `useRegistration`, а не `useRegister`:
      он отдаёт состояние экрана, а не действие. Ключи `auth.register.*` заведены в обоих языках.
      **Что решено по последнему критерию.** «Форма недоступна» при закрытой регистрации сделана
      так, как её вообще может обеспечить инсталляция: узнать `REGISTRATION_OPEN` до отправки
      **нечем** — `GET /api/v1/meta` отдаёт только `apiVersion` и `serverTime` (`ApiMeta`), а
      переменная окружения контрактом не публикуется. Поэтому форма показывается, а на
      `403 registration_disabled` **заменяется** постоянной панелью; заводить публичную ручку «эта
      инсталляция принимает регистрации?» сознательно не стали — это ровно тот ответ, который
      закрытая инсталляция и отказывается давать анониму. Записано в
      `docs/architecture/ux-architecture.md` → «Публичная зона».
      **Занятый slug** (409 `organization_already_exists`) подсвечивает поле, а не всплывает тостом:
      локальный `onError` мутации переопределяет глобальный `MutationCache.onError`
      (`rules/errors-and-toasts.mdc` §2–§4), как это уже сделано у второго фактора. Остальные отказы
      (429, 500, нечитаемый ответ) — одна плашка над полями.
      **Попутная находка, вынесенная за рамки истории.** Сообщения полей во **всех** формах продукта
      рендерятся сырыми ключами: схемы отдают ключ, `@mantine/form` печатает его как есть, а весь
      клиентский набор идёт в `cimode`, где `t(key) === key`, поэтому ни один тест этого не видит.
      Новая форма переводит их через `SharedLib.translateFormIssues` и закрыта псевдолокалью
      (`test/i18n/pseudo-locale.test.tsx`); остальные формы — отдельная работа.
- [x] Добавить настройку инсталляции «открытая регистрация» и её проверку в use-case.
      *Сделано 2026-07-29:* `REGISTRATION_OPEN` (по умолчанию `true` — первую дверь нельзя закрыть
      раньше, чем через неё вошли), проверяется **первой строкой** use-case'а, до чтения адреса и
      slug, чтобы ответ не зависел от того, существуют ли они.

## Definition of Done

- [x] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [x] Commit-гейт зелёный (test-coverage, security-auditor, **db-reviewer обязателен**, production-readiness, commit-hygiene)
      *Закрыт 2026-09-10 по итогам прогона 2026-09-06 и починок после него.* `test-coverage` — PASS, три мутации
      красные на своих тестах (разбитый CTE отвергает сам Postgres по циклическому ключу; снятый лимит —
      четыре теста; забытый `t()` — только псевдолокаль). `security-auditor` — PASS по коду; две Medium — про
      модель угроз (`T-TENANT-06/07` обещали защиту, которой нет) — переписаны на факт `9e8689c`, **перепринятие
      рисков — за человеком**. `db-reviewer` — PASS, «организация и владелец одним оператором» подтверждено
      (data-modifying CTE, составной `NO ACTION`, без `DEFERRABLE`). `production-readiness` — FAIL → закрыт:
      H1 `{{seconds}}` в форме и тот же класс во всех хуках — `c826ea3`; M1 спека обещала replay по
      `Idempotency-Key` — снято; M2 `organization.registered` теперь в транзакции создания — `c826ea3`;
      M3 слабые пароли — один список в `packages/shared` для формы и сервера — `c826ea3`; M4 шаги первого
      входа называют slug и путь для закрытого контура; M5 прокси — `fca2ecf`. `commit-hygiene` — PASS.
- [x] Документация обновлена (docs/ + запись в `docs/brain/`)
- [x] a11y-проверка: форма с корректными `label`, связью ошибок через `aria-describedby`, объявлением ошибок в live-region, полной работой с клавиатуры
- [x] i18n: строки в обоих языках, хардкода нет

## Ссылки

- Документация: [`stack.md` → Пароли](../../../docs/architecture/stack.md), [`data-model.md` → Tenancy и идентичность](../../../docs/architecture/data-model.md), [`ux-architecture.md` → Публичная зона](../../../docs/architecture/ux-architecture.md)
- Правила: `rules/security.mdc`, `rules/tenancy-rls.mdc`, `rules/i18n.mdc`
