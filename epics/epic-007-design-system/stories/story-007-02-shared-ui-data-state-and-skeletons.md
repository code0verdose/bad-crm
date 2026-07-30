---
id: STORY-007-02
epic: EPIC-007
status: review
blocked: false
priority: must
estimate: M
---

**Закрыта фактически в EPIC-004 и EPIC-006.** `shared/ui` содержит `data-state` (с `EmptyState` и
`ErrorState`), `skeletons`, `page-header`, `centered-screen`; поведение «ошибка списка инлайн, ошибка
действия тостом» заложено глобальным `MutationCache.onError`. Проверено сверкой 2026-07-30.


# STORY-007-02 — DataState, скелетоны, EmptyState, PageHeader

**Как** разработчик (пользователь продукта) **я хочу** предсказуемые состояния каждого экрана
**чтобы** всегда понимать, идёт ли загрузка, случилась ли ошибка и что делать, если данных ещё нет.

## Acceptance (Given/When/Then)

- **Given** экран, обёрнутый в `DataState` со статусом `pending` **When** он рендерится **Then** показывается переданный скелетон, повторяющий структуру будущего контента, а не универсальный спиннер.
- **Given** статус `error` **When** он установлен **Then** показывается `ErrorState` с человекочитаемым текстом по коду ошибки и кнопкой «Повторить», вызывающей `onRetry`; тост при этом не показывается.
- **Given** статус `success` и пустой список **When** он рендерится **Then** показывается `EmptyState` с иконкой, заголовком, объяснением следующего шага и первичным действием (например, «Создать проект»).
- **Given** рефетч при смене фильтра **When** предыдущие данные уже есть **Then** используется `keepPreviousData`, контент не подменяется скелетоном, а помечается как обновляющийся (`aria-busy`).
- **Given** `PageHeader` **When** он рендерится **Then** он содержит хлебные крошки, единственный `h1`, бейдж области видимости («Только вы» / «Организация» / название проекта), действия справа и опциональные вкладки.
- **Given** набор скелетонов **When** смотрю его состав **Then** есть `TextSkeleton`, `TableSkeleton`, `CardGridSkeleton`, `BoardSkeleton`, `ChatSkeleton`, `EditorSkeleton`, `CalendarSkeleton`, `MatrixSkeleton`; каждый принимает число строк/элементов.
- **Given** компонент из `shared/ui` **When** запускается архитектурный тест **Then** он не импортирует юниты, не использует `useQuery` и не знает о доменах.
- **Given** скринридер **When** состояние меняется с загрузки на контент или ошибку **Then** изменение объявляется через live-region, а зона загрузки помечена `aria-busy="true"`.

## Задачи

- [ ] Написать тесты первыми: `shared/ui/data-state.component.test.tsx` (четыре состояния, `onRetry`, `aria-busy`), `shared/ui/empty-state.component.test.tsx`, `shared/ui/page-header.component.test.tsx` (один `h1`, крошки, бейдж), `test/architecture/shared-ui-purity.test.ts`.
- [ ] Реализовать `src/shared/ui/data-state.component.tsx` с пропсами `status`, `error`, `onRetry`, `skeleton`, `empty`, `children`.
- [ ] Реализовать `src/shared/ui/error-state.component.tsx` и `empty-state.component.tsx`.
- [ ] Реализовать `src/shared/ui/page-header.component.tsx` (крошки, `h1`, бейдж области, действия, вкладки).
- [ ] Реализовать набор `src/shared/ui/skeletons/*` по перечню из [`ux-architecture.md`](../../../docs/architecture/ux-architecture.md).
- [ ] Реализовать `src/shared/ui/index.ts` c namespace-реэкспортом и подключить к `@shared`.
- [ ] Добавить архитектурный тест чистоты `shared/ui` (нет импортов юнитов, нет сетевых вызовов).
- [ ] Вынести все тексты состояний в `common.json` (EN/RU) — компоненты принимают ключи или уже переведённые строки от вызывающего.

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y-проверка: live-region на смену состояния, `aria-busy`, кнопка повтора достижима с клавиатуры
- [ ] i18n: строки в обоих языках, хардкода нет

## Ссылки

- Документация: [`ux-architecture.md` → Состав `shared/ui`, Принцип 3 (пустое состояние объясняет шаг)](../../../docs/architecture/ux-architecture.md)
- Правила: `rules/design-system.mdc`, `rules/a11y.mdc`, `rules/i18n.mdc`
