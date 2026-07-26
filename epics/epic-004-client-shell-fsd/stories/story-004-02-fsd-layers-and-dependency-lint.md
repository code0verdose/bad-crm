---
id: STORY-004-02
epic: EPIC-004
status: backlog
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

- [ ] Написать тесты первыми: `test/architecture/layers.test.ts` (матрица разрешённых направлений импорта), `test/architecture/barrels.test.ts` (импорт юнита только через barrel, namespace-реэкспорт), `test/architecture/structure.test.ts` (нет пустых сегментов, соблюдены суффиксы).
- [ ] Создать каркас `src/app` (`main.tsx`, `providers.tsx`, `router.tsx`, `styles/`), `src/pages`, `src/widgets`, `src/units`, `src/shared` (`api`, `ui`, `lib`, `hooks`).
- [ ] Создать `src/shared/index.ts` с namespace-реэкспортом (`SharedUi`, `SharedLib`, `SharedHooks`, `SharedApi`).
- [ ] Создать эталонный юнит-заглушку `src/units/session` с сегментами `api`, `service/{queries,mutations,hooks}`, `model`, `types`, `ui` и barrel — образец для последующих доменов.
- [ ] Настроить `import/no-restricted-paths` (зоны по слоям) и `no-restricted-imports` (запрет глубоких путей в юниты).
- [ ] Добавить правило `react-hooks/exhaustive-deps` + собственное правило/тест против `useEffect` для загрузки данных и производного состояния.
- [ ] Задокументировать структуру в `docs/architecture/ux-architecture.md` (при необходимости уточнить) и в `rules/frontend-fsd.mdc`.

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y-проверка (для UI-историй) — не применимо
- [ ] i18n: строки в обоих языках, хардкода нет (для UI-историй) — не применимо

## Ссылки

- Документация: [ADR-0005](../../../docs/architecture/adr/0005-fsd-units-frontend-architecture.md), [`ux-architecture.md`](../../../docs/architecture/ux-architecture.md), [`overview.md` → FSD «units»](../../../docs/architecture/overview.md)
- Правила: `rules/frontend-fsd.mdc`, `rules/naming-and-structure.mdc`
