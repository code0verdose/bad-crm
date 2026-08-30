---
date: 2026-08-30
project: bad-crm
tags: [nodemailer, prom-client, argon2, express, prisma, vitest]
---

# Трата кода восстановления: письмо владельцу и счётчик серии

## Простым языком

1. Когда человек входит по резервному коду вместо приложения-аутентификатора, теперь ему приходит
   письмо — чтобы владелец учётной записи узнал об этом сам, а не через администратора, который
   когда-нибудь откроет журнал. Запись в журнале была и раньше, но журнал читают редко и не те люди.
2. Письмо уходит **после** того, как транзакция закрыта, и его отправка не может отменить уже
   состоявшийся вход — если почта не настроена или учётная запись успела исчезнуть, вход остаётся в
   силе, а письма просто нет.
3. Появился счётчик неудачных попыток по резервным кодам — чтобы оператор видел перебор до того, как
   он закончится успехом. Раньше в метриках было видно только момент, когда ограничитель уже начал
   отказывать, то есть с шестой попытки; первые пять — самые интересные — не считал никто.
4. Серия неудач теперь оставляет **одну** запись в журнале действий, а не ноль и не по записи на
   каждую попытку. Её пишет та неудача, которая исчерпала бюджет.

## Технически

1. `packages/server/src/application/identity/use-cases/consume-recovery-code.use-case.ts` —
   добавлены `UserRepositoryPort`, `MetricsPort`, `MailDispatchPort` и `appUrl`. Учётные данные
   читаются **внутри** `unitOfWork.withTenant` (`guardedClient` отвергает чтение вне tenant-скоупа),
   а `dispatch` вызывается после его закрытия — тот же порядок, что в `confirm-totp.use-case.ts:314`
   и `disable-totp.use-case.ts:305`. `MailDispatchPort.dispatch` по контракту не бросает.
2. `packages/server/src/domain/identity/mfa-changed-mail.util.ts` — причина `recovery_code_used`,
   шаблоны EN и RU. Никакого секрета в теле, ссылка только на `/settings/security`.
3. `packages/server/src/domain/identity/security-event.constant.ts` — событие `recoveryCodeUsed`
   для `MailDispatchContext.event`.
4. `packages/server/src/application/platform/ports/metrics.port.ts` — седьмой метод
   `incrementMfaRecoveryFailed()`; `prom-client.adapter.ts` регистрирует `mfa_recovery_failed_total`
   (Counter, без меток), `noop-metrics.adapter.ts` — заглушку. Обобщённого метода в порте нет: все
   шесть существующих именные, и `incrementAuthRateLimited(endpoint)` считает другое событие —
   отказ ограничителя, а не отвергнутый код.
5. `packages/shared/src/audit/audit-action.enums.ts` и `audit-severity.enums.ts` — действие
   `user.mfa_recovery_locked_out` (`WARNING`). Триггер — `decision.remaining === 0` на отвергнутой
   попытке: это последняя попытка, которую ограничитель пропустил, поэтому запись выходит ровно
   одна за окно. `after` несёт только имя политики.
6. Проводка: `infrastructure/bootstrap/container.factory.ts` (`metrics` протянут в `buildIdentity`),
   `test/support/auth-app.util.ts`, `test/unit/application/verify-second-factor.use-case.test.ts`.

## Что стоило времени

**`packages/shared` проверяется на изоморфность регуляркой по словам.** Комментарий с фразой
«a fresh window.» уронил `test/config/isomorphic.test.ts`: паттерн `\b(window|document|…)\s*[.[]`
не отличает браузерный глобал от английского слова. Тест прав по назначению и груб по реализации;
дешевле переписать фразу, чем ослаблять гейт.

**Каталог действий журнала сверяется в двух местах.** Новое имя надо внести и в
`packages/shared/src/audit/`, и в дословный список `test/unit/audit/audit-logger.test.ts`; плюс
`test/unit/audit/audit-coverage.test.ts` требует, чтобы у имени был реальный call-site в `src`.

## Применённые технологии

- [[prom-client]] — счётчик без меток; метка исхода публиковала бы на `/metrics` то различие,
  которое ответ прячет фиксированной стоимостью сверки Argon2id.
- [[nodemailer]] — через `MailDispatchPort`, fire-and-forget после коммита.
- [[Vitest]] — красный прогон до реализации, `createPromMetrics()` в юнит-тесте: утверждение делается
  по тексту экспозиции, а не по «вызвали ли счётчик».

## Связи

- Проект: [[Projects/bad-crm]]
- Related: [[2026-08-16--three-holes-that-only-a-measurement-found]]
