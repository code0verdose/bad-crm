---
id: STORY-004-02
epic: EPIC-004
status: review
blocked: false
priority: must
estimate: M
---

# STORY-004-02 — Скелет слоёв FSD, namespace-барели, линт зависимостей

**Как** разработчик Bad CRM **я хочу** зафиксированную структуру слоёв с проверяемым направлением
зависимостей **чтобы** доменная логика не расползалась по компонентам, а публичное API юнита
нельзя было обойти импортом вглубь.

## Acceptance (Given/When/Then)

- **Given** слои `app → pages → widgets → units → shared` **When** в `shared` появляется импорт из `@units/...` **Then** `pnpm lint` падает: зависимости идут только вниз.
- **Given** импорт `@units/auth/service/hooks/use-login.hook` (вглубь юнита) **When** запускаю линт **Then** он падает: наружу торчит только `index.ts` юнита.
- **Given** barrel юнита **When** смотрю его содержимое **Then** сегменты реэкспортированы как namespace (`export * as AuthService from './service'`), и потребление выглядит как `AuthService.useLogin()`.
- **Given** компонент с бизнес-логикой в теле (расчёт, маппинг, форматирование) **When** проходит ревью и линт **Then** правило «UI — только вёрстка, хендлеры и вызовы хуков» нарушено: логика должна быть в `service/hooks` юнита или в `*.util.ts`.
- **Given** `useEffect`, синхронизирующий производное состояние **When** запускается линт-правило анти-`useEffect` **Then** выдаётся ошибка с подсказкой (вычислять при рендере / `useMemo` / `key` / обработчик события); оставленный эффект требует комментария с обоснованием.
- **Given** пустой сегмент (`stores`, `validation`) без файлов **When** запускается тест структуры **Then** он падает: пустые каталоги не создаются заранее.
- **Given** новый юнит, созданный по шаблону **When** запускается тест структуры **Then** проверяется наличие `index.ts` и корректность role-суффиксов внутри сегментов.

## Задачи

- [x] Написать тесты первыми: `test/architecture/layers.test.ts` (матрица разрешённых направлений импорта), `test/architecture/barrels.test.ts` (импорт юнита только через barrel, namespace-реэкспорт), `test/architecture/structure.test.ts` (нет пустых сегментов, соблюдены суффиксы).
      Каждый проверен на настоящем нарушении (пустой каталог, deep-import со страницы, импорт
      вверх из юнита), а не только на зелёном дереве.
- [x] Создать каркас `src/app` (`main.tsx`, `providers.tsx`, `router.tsx`, `styles/`), `src/pages`, `src/widgets`, `src/units`, `src/shared` (`api`, `ui`, `lib`, `hooks`).
      `providers.tsx` и `router.tsx` — за STORY-004-04/004-05 (нечего провайдить и нечего
      маршрутизировать); вместо `styles/` — один `app/global.css` (reset, `color-scheme`,
      `prefers-reduced-motion`), токены приходят с Mantine в 004-03. `shared/ui`, `shared/lib`,
      `shared/hooks` **не созданы**: пустой сегмент — это ложное обещание, и его ловит
      `structure.test.ts`, который эта же история и требует.
- [x] Создать `src/shared/index.ts` с namespace-реэкспортом (`SharedUi`, `SharedLib`, `SharedHooks`, `SharedApi`).
      Сегодня в нём `SharedApi` и `SharedConfig` — ровно то, что существует; тест барелей требует
      строку на каждый существующий сегмент и запрещает строку на несуществующий.
- [x] Создать эталонный юнит-заглушку `src/units/session` с сегментами `api`, `service/{queries,mutations,hooks}`, `model`, `types`, `ui` и barrel — образец для последующих доменов.
      Сегменты `api`, `service/queries`, `service/mutations` **не заведены**: HTTP-клиента нет до
      STORY-004-06, а пустой сегмент запрещён (см. выше). Есть `model`, `types`,
      `service/hooks`, `ui` и namespace-barrel. Отдельно: строки `units/session` нет в
      `docs/product/glossary.md` — её нужно завести до `test/architecture/unit-names`.
- [x] Настроить `import/no-restricted-paths` (зоны по слоям) и `no-restricted-imports` (запрет глубоких путей в юниты).
      Проверка на настоящем дереве вскрыла дефект прежней конфигурации: запрет `@units/*/*` был
      навешен и на сами юниты, из-за чего юнит не мог импортировать **собственные** сегменты, а
      `../` запрещён — то есть юнит был невыразим. Разведено: соседние слои — прежним
      `no-restricted-imports`, чужие юниты — новым правилом `bad-crm/no-foreign-unit-internals`,
      которое сравнивает импорт с юнитом импортирующего файла.
- [x] Добавить правило `react-hooks/exhaustive-deps` + собственное правило/тест против `useEffect` для загрузки данных и производного состояния.
      `react-hooks` уже подключён; добавлено `bad-crm/no-effect-for-derived-state`: эффект,
      состоящий только из сеттеров, — ошибка «считай при рендере»; любой другой эффект без
      комментария-обоснования — ошибка «объясни, почему это настоящий сайд-эффект». Фикстуры
      включают положительный контроль (подписка с cleanup и обоснованием проходит).
- [x] Задокументировать структуру в `docs/architecture/ux-architecture.md` (при необходимости уточнить) и в `rules/frontend-fsd.mdc`.
      Обе названные правки в `rules/frontend-fsd.mdc` на месте: (а) правило 3 содержит
      «Уточнение (2026-07-28, найдено на первом настоящем дереве)» — запрет deep-import относится к
      **чужому** юниту, свои сегменты импортируются напрямую; (б) в таблицу «Как проверяется»
      добавлены строки `bad-crm/no-foreign-unit-internals` и `bad-crm/no-effect-for-derived-state`.
      `ux-architecture.md` правки не потребовал («при необходимости»): раскладка слоёв FSD там не
      описана — она живёт в [ADR-0005](../../../docs/architecture/adr/0005-fsd-units-frontend-architecture.md)
      и в `rules/frontend-fsd.mdc`, а `ux-architecture.md` описывает экраны и дизайн-систему.

## Definition of Done

- [x] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [x] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [x] Документация обновлена (docs/ + запись в `docs/brain/`) — `rules/frontend-fsd.mdc` (см. задачу выше) и запись [`docs/brain/2026-07-28--client-foundation-and-csp-in-a-browser.md`](../../../docs/brain/2026-07-28--client-foundation-and-csp-in-a-browser.md) (STORY-004-01 и STORY-004-02)
- [x] a11y-проверка (для UI-историй) — не применимо
- [x] i18n: строки в обоих языках, хардкода нет (для UI-историй) — не применимо

## Ссылки

- Документация: [ADR-0005](../../../docs/architecture/adr/0005-fsd-units-frontend-architecture.md), [`ux-architecture.md`](../../../docs/architecture/ux-architecture.md), [`overview.md` → FSD «units»](../../../docs/architecture/overview.md)
- Правила: `rules/frontend-fsd.mdc`, `rules/naming-and-structure.mdc`
