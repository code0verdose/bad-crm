---
date: 2026-08-12
project: bad-crm
tags: [vitest, testing-library, axe-core, mutation-testing, mantine, tanstack-query]
---

# Доказательство красноты для тестов 2FA-экранов (STORY-013-02 хвост)

## Простым языком

1. Взял 39 тестовых случаев в `packages/client`, которые автор экранов 2FA написал, но никогда не
   видел падающими — сообщения о падении были сняты заранее, и это честно записано как долг.
2. Для каждого случая внёс в исходный код ровно тот дефект, который он обязан ловить, прогнал тест
   точечно (`--coverage.enabled=false`), увидел падение с осмысленным сообщением, сразу откатил
   правку (`git checkout --`). Никаких изменений в репозитории не осталось.
3. Особое внимание — трём местам, где типичная ошибка мутационного тестирования маскирует пробел:
   утечка кодов восстановления (проверил отдельно хранилище, адресную строку и тело следующего
   запроса — три разных дефекта, не один), скачивание `.txt` (усилил себе проверку, что дефект ловит
   именно содержимое файла, а не только факт вызова) и скан axe (использовал встроенный CONTROL
   `axe-scan.util.ts`, который проверяет, что скан вообще что-то увидел в нужном поддереве).
4. Ни один из случаев не оказался «недоказуемым» — для всех 39 удалось подобрать дефект, который тест
   ловит с содержательным сообщением.
5. В конце — один эксклюзивный прогон всего пакета с покрытием (`pnpm --filter @bad-crm/client test`):
   109 файлов, 1314 тестов, 100% строк/веток/функций. Плюс `pnpm i18n:check` и
   `pnpm turbo run typecheck lint --filter @bad-crm/client` — всё зелёное.

## Технически

1. Работал строго в `packages/client/**`, следуя режиму параллельной работы из `rules/testing.mdc`
   («Режим параллельной работы»): каждая мутация — отдельная волна из одного файла, immediately
   revert, диагностические прогоны с `--coverage.enabled=false`, полный прогон с покрытием — один раз
   в конце, эксклюзивно.
2. `packages/client/test/widgets/totp-setup.test.tsx` — 4 случая: `axe` на трёх состояниях экрана
   (дефекты в `src/widgets/app-shell/ui/sign-out-control.component.tsx`,
   `src/units/auth/ui/totp-qr.component.tsx`, `src/units/auth/ui/recovery-codes-dialog.component.tsx`)
   и отказ Trusted Types (`src/app/trusted-types.util.ts:42` — инверсия условия).
3. `packages/client/test/widgets/recovery-codes.test.tsx` — все 22 случая: пороговое значение
   `RECOVERY_CODES_LOW_THRESHOLD` (`src/units/auth/service/hooks/use-recovery-codes.hook.ts:7`) для
   счётчика и обеих границ (3 и 4); `retry`, `dismissCodes`, `invalidateQueries` в том же файле;
   тело запроса и `onError`-переопределение в `src/units/auth/service/mutations/regenerate-recovery-codes.mutation.ts`
   и `src/units/auth/api/mfa.api.ts`; фокус-ловушка, `closeOnEscape`, порядок фокуса и стартовое
   состояние чекбокса в `src/units/auth/ui/recovery-codes-dialog.component.tsx`; содержимое файла и
   `data-bc-print` в `src/units/auth/lib/download-recovery-codes.util.ts` и
   `src/units/auth/ui/recovery-codes-list.component.tsx`; три варианта утечки кодов (`localStorage`,
   `history.replaceState`, второй `fetch`) в мутации reissue; четыре `axe`-скана (button-name ×3 через
   `sign-out-control.component.tsx`, aria-allowed-attr через невалидный `aria-checked` на `<ul>`).
4. `src/units/auth/lib/download-recovery-codes.util.test.ts` (5) и
   `src/units/auth/lib/qr-image-source.util.test.ts` (3) — точечные дефекты в
   `recoveryCodesFileText`, `RECOVERY_CODES_FILE_NAME`/mime, `revokeObjectURL`, `anchor.remove()`,
   `encodeURIComponent` (mime data URI, escaping, целостность документа).
5. `test/ui/toaster.test.tsx` — 1 случай: `aria-label` дефолт-пропа `Notification` в
   `src/shared/ui/toaster/toaster.component.tsx:37`.
6. `test/widgets/nav-sections.test.ts` — 4 случая: удаление и (отдельным прогоном) добавление
   `permission` записи `/settings/security` в
   `src/widgets/app-shell/model/nav-sections.constant.ts:54` — второй, более точечный дефект изолирует
   именно случай «объявляет отсутствие permission», не совпадая с первым.
7. Финальная проверка: `pnpm --filter @bad-crm/client test` (100% lines/branches/functions/statements),
   `pnpm i18n:check` (493/493 ключей на оба языка), `pnpm turbo run typecheck lint --filter @bad-crm/client`.
   Дерево осталось чистым (`git status --short packages/client` — пусто) до и после сессии.

## Применённые технологии

- [[Vitest]] — точечные прогоны через `-t`, `--coverage.enabled=false` для диагностики, полный прогон
  с покрытием — эксклюзивно и один раз.
- [[Testing Library]] — `findByRole`/`findByText`/`waitFor` как источник таймаутов, которые тоже
  считаются валидным доказательством красноты, когда точная assertion недостижима без конфликта с
  предусловием теста.
- [[axe-core]] — `axeViolationsIn` с встроенным CONTROL (`toContain(control)` по `passes`), который
  ловит именно класс ошибок «скан посмотрел не туда/не то».
- [[TanStack Query]] — `MutationCache.onError` fallback и локальный override, использованные как
  точка дефекта для доказательства «один сигнал на действие».
- [[Mantine]] — `Modal` (`trapFocus`, `closeOnEscape`, `closeButtonProps`), `Notifications`/
  `MantineThemeProvider` defaultProps.

## Связи

- Проект: [[Projects/bad-crm]]
- Related: [[2026-07-29--auth-vertical-and-unrun-suites]], [[2026-08-08--the-report-that-admits-what-it-could-not-do]]
