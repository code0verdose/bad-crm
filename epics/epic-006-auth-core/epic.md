---
id: EPIC-006
title: Ядро аутентификации
status: in-progress
blocked: false
milestone: M1
owner: unassigned
created: 2026-07-26
---

# EPIC-006 — Ядро аутентификации

## Зачем (ценность)

Вход — единственная дверь в продукт: без него нельзя проверить ни одну другую функцию, а
некорректная реализация сессий обесценивает и модель прав, и изоляцию арендаторов. Эпик даёт
регистрацию организации с владельцем, вход по email и паролю, короткоживущий access-токен и
refresh-cookie с ротацией и обнаружением повторного использования, управление активными сессиями,
смену и сброс пароля, а также защиту от перебора. После него M1 становится проверяемым сквозным
сценарием «зарегистрировался → вошёл → увидел оболочку → вышел».

## Scope

### В скоупе

- Регистрация организации и её владельца: argon2id, политика пароля в Zod.
- Логин: короткий JWT access + opaque refresh в httpOnly cookie (`SameSite=Lax`, `Secure`, ограниченный `Path`).
- Ротация refresh с reuse detection: повторное предъявление отзывает всё семейство сессий.
- Logout, список активных сессий (устройство, IP, последняя активность), отзыв конкретной сессии.
- Клиентская часть: bootstrap сессии, `beforeLoad`-гард, редирект с `search.redirect`.
- Смена пароля с инвалидацией остальных сессий.
- Rate limiting и временная блокировка на login/refresh/reset поверх Redis.
- Сброс пароля по email (в dev — Mailpit), одноразовый токен с TTL.

### Вне скоупа

- 2FA (TOTP) и коды восстановления — [EPIC-013](../epic-013-two-factor-totp/epic.md) (M2).
- Каталог permissions, кастомные роли и ACL — [EPIC-011](../epic-011-rbac-permissions/epic.md) (M2); здесь только системные роли, созданные при bootstrap.
- Приглашения сотрудников и офбординг — [EPIC-012](../epic-012-employee-management/epic.md) (M2).
- SSO/SAML/OIDC — Won't в 1.0 (см. PRD).

## Acceptance (эпик выполнен, когда)

- [ ] Пользователь регистрирует организацию, входит, видит оболочку приложения и выходит — сквозной e2e-сценарий зелёный.
- [ ] Пароли хранятся как argon2id с параметрами не ниже рекомендаций OWASP; при изменении параметров старые хеши продолжают проверяться и прозрачно перехешируются при следующем успешном входе.
- [ ] Access-токен живёт 15 минут и хранится только в памяти клиента; refresh — opaque, в httpOnly cookie, в БД хранится его SHA-256 хеш.
- [ ] Повторное предъявление уже использованного refresh отзывает всё семейство сессий, пишет событие в аудит и уведомляет пользователя.
- [ ] Пользователь видит свои активные сессии с устройством, IP и временем и может отозвать любую, кроме текущей (или включая текущую с явным подтверждением).
- [ ] Смена пароля закрывает все прочие сессии; текущая сохраняется.
- [ ] 5 неудачных попыток входа за 15 минут по паре IP + email приводят к 429 с `Retry-After`; счётчик общий для всех реплик приложения.
- [ ] Сброс пароля работает по одноразовой ссылке с TTL; повторное использование токена отклоняется; при отсутствии SMTP операция даёт понятную ошибку, а в dev письмо видно в Mailpit.
- [ ] Ответ на «пользователь не существует» и «неверный пароль» неотличим по коду, тексту и времени ответа.

## Что фундамент эпика уже закрыл (ревизия 2026-07-28)

Сделано до реализации операций, потому что каждый пункт после релиза дорожает или становится
необратимым:

- **Третья форма записи маршрута** — `SelfServiceRoute` в
  `packages/server/src/presentation/http/route-registry.types.ts` (аутентификация остаётся, право не
  проверяется, место проверки владения обязано быть названо); `openapi.test.ts` сверяет её с
  маркером спеки в обе стороны. Подробности — в [STORY-006-04](stories/story-006-04-logout-and-active-sessions.md).
- **`Session.ipMasked`** — колонка `NOT NULL` и обязательное поле контракта; полный адрес не
  хранится нигде (`docs/architecture/data-model.md`, «Про адрес сессии»).
- **`session_revoked_reason.OFFBOARDING`** вместо `USER_DELETED`: то же значение закрывает сессии
  приостановленного аккаунта, где ничего не удалено, и его буквально требует
  [STORY-012-05](../epic-012-employee-management/stories/story-012-05-offboarding.md). Значение
  PG-enum не переименовать без пересоздания типа — момент был сейчас.
- **`updated_at` держит триггер БД**, а не `@updatedAt` клиента Prisma: отзыв семейства и офбординг
  описаны как сырой `UPDATE`, мимо которого клиентский атрибут не срабатывает.
- **Граница `mail_not_configured` (503) и `feature_disabled` (501)** — противоречие внутри
  `error-code.enums.ts` снято; решение об отсутствии SMTP на `/auth/forgot-password` принимается
  **до** резолва адреса, иначе код становится оракулом существования адреса.
- **`x-implemented-by` затянут**: маркер обязан называть **открытую** историю **своего** эпика —
  раньше подходила любая существующая, включая закрытую и из чужого эпика.
- **Примеры идентификаторов в спеке — uuid**, как и все ключи модели; ULID остался только у
  `requestId`, и это проверяется тестом.

## Зависимости / риски

- Зависит от: [EPIC-005](../epic-005-multi-tenancy-rls/epic.md) (арендатор и bootstrap организации), [EPIC-003](../epic-003-server-skeleton-and-api-contract/epic.md) (контракт и валидация), [EPIC-004](../epic-004-client-shell-fsd/epic.md) (клиент, роутер, API-клиент).
- Блокирует: [EPIC-011](../epic-011-rbac-permissions/epic.md), [EPIC-012](../epic-012-employee-management/epic.md), [EPIC-013](../epic-013-two-factor-totp/epic.md), [EPIC-010](../epic-010-e2e-harness/epic.md) (сценарии под ролью).
- Риски: кража refresh-токена — митигируется ротацией с reuse detection и отзывом семейства; перебор паролей — rate limiting и lockout на Redis; утечка токена через логи — редактирование путей в pino; user enumeration — единый ответ и постоянное время; **R-01** — все новые таблицы (`User`, `Session`) получают RLS по чек-листу EPIC-005.

## Ссылки

- Документация: [`stack.md` → Безопасность в коде (пароли, токены, rate limiting)](../../docs/architecture/stack.md), [`data-model.md` → Tenancy и идентичность](../../docs/architecture/data-model.md), [`rls-design.md` → Особые пути: путь 1 (логин)](../../docs/security/rls-design.md), [`ux-architecture.md` → Публичная зона, Гарды](../../docs/architecture/ux-architecture.md), [`threat-model.md`](../../docs/security/threat-model.md)
- Правила: `rules/security.mdc`, `rules/api-contract.mdc`, `rules/frontend-fsd.mdc`

## Истории

- [ ] [STORY-006-01 — Регистрация организации и владельца](stories/story-006-01-organization-and-owner-registration.md)
- [ ] [STORY-006-02 — Логин: access-токен и refresh в httpOnly cookie](stories/story-006-02-login-access-and-refresh-cookie.md)
- [ ] [STORY-006-03 — Ротация refresh и обнаружение повторного использования](stories/story-006-03-refresh-rotation-reuse-detection.md)
- [ ] [STORY-006-04 — Logout и управление активными сессиями](stories/story-006-04-logout-and-active-sessions.md)
- [ ] [STORY-006-05 — Клиент: bootstrap сессии, гард, redirect](stories/story-006-05-client-session-bootstrap-and-guards.md)
- [ ] [STORY-006-06 — Смена пароля и инвалидация остальных сессий](stories/story-006-06-change-password-and-session-invalidation.md)
- [ ] [STORY-006-07 — Rate limiting и lockout на login/refresh/reset](stories/story-006-07-auth-rate-limiting-and-lockout.md)
- [ ] [STORY-006-08 — Сброс пароля по email с одноразовым токеном](stories/story-006-08-password-reset-by-email.md)
