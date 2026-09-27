---
id: STORY-014-06
epic: EPIC-014
status: in-progress
blocked: false
priority: should
estimate: M
---

# STORY-014-06 — Переключатель проекта и контекст в URL

**Как** разработчик (P4) **я хочу** переключать текущий проект из шапки и видеть контекст проекта
прямо в адресе, **чтобы** одна ссылка приводила коллегу в тот же проект и тот же раздел, а не
«в приложение, где надо ещё найти нужное».

> **Сверено с кодом 2026-09-06.** История написана 2026-07-26, до EPIC-011 и EPIC-012. Текст ниже
> оставлен как запись замысла; расхождения с деревом — здесь.
>
> **Пути и имена.**
> - Каталога `application/<контекст>/queries/` нет: чтения лежат в `use-cases/` рядом с командами
>   и различаются суффиксом (`application/iam/use-cases/list-teams.query.ts`). То есть
>   `list-project-options.query.ts` ложится в `application/project/use-cases/`.
> - Namespace локали называется `nav.json`, а не `navigation.json`, и лежит в
>   `packages/client/src/shared/i18n/locales/{en,ru}/`. Набор namespace обязан совпадать в обоих
>   языках — это гейт `pnpm i18n:check`.
> - Клиентские тесты — `*.test.ts`; `.spec.ts` носят только сценарии `packages/e2e` (для
>   `project-switcher.spec.ts` имя верно, для `use-project-switcher.hook.spec.ts` — нет).
> - `ROUTE_REGISTRY` из состава — это `createRouteRegistry` в
>   `packages/server/src/presentation/http/route-registry.factory.ts`; файла
>   `presentation/http/routes/registry.ts` не существует.
>
> **Критерий 6 описывает не тот механизм, что в коде.** «`permissionsVersion` изменился,
> `me/permissions` инвалидирован» верно только наполовину, и половины стоит развести:
> - **На сервере кеша прав нет и не будет.** Актор пересобирается на каждый запрос; §8 модели прав
>   проектировала 60-секундный кеш в Redis по `permissionsVersion`, но 2026-09-06 стоимость чтения
>   была **замерена** (5.4 мс среднее, 6.0 мс p95 на 317 действующих ключах) и кеш отвергнут, а не
>   отложен — обоснование в `application/iam/use-cases/build-actor.query.ts:30-42`. Инвалидировать
>   на сервере нечего, и именно поэтому «доступ пропал немедленно» держится по построению.
> - **На клиенте кеш есть — это кеш TanStack Query.** `GET /me/permissions` существует
>   (`units/iam/api/iam.api.ts:15`) и отдаёт `ETag` вида `"perm-<userId>-<version>"`, где версия —
>   `permissionsVersion`. Значит критерий про инвалидацию адресован клиентскому query-ключу
>   (`shared/lib/enums/query-keys.constant.ts`), а не серверному кешу.
>
> **Чего история не называет, а гейты требуют.** Лёгкий эндпоинт из критерия 9 обязан появиться в
> `docs/api/openapi.yaml`: спека сверяется со стеком Express в обе стороны
> (`packages/server/test/contract/openapi.test.ts:166`). И если `project:read` встаёт на маршрут
> здесь первым — **в том же коммите** нужны сентенции `permission.project.*` на EN и RU и удаление
> строки `project` из `AWAITING_A_ROUTE`
> (`packages/client/test/i18n/permission-descriptions.test.ts:59`).

## Acceptance (Given/When/Then)

1. **Контекст проекта — в пути, а не в состоянии.**
   Given пользователь работает в проекте;
   When он находится на любом проектном экране;
   Then текущий проект определяется сегментом пути `/projects/$projectId/**`; глобального
   «выбранного проекта» в клиентском сторе, влияющего на данные, **не существует** — иначе ссылка
   перестаёт быть воспроизводимой.

2. **Переключение сохраняет раздел.**
   Given пользователь на `/projects/p1/files?folder=f9`;
   When он выбирает проект `p2` в переключателе;
   Then происходит навигация на `/projects/p2/files`; параметры, зависящие от прежнего проекта
   (`folder`), сбрасываются схемой (`stripSearchParams`), а универсальные (`view`, `sort`)
   сохраняются (`retainSearchParams`).

3. **Быстрый поиск в переключателе.**
   Given открытый переключатель;
   When пользователь печатает;
   Then поиск debounce'ится (300 мс), запрос отменяется по `signal`, показываются только доступные
   проекты; последние 5 посещённых закреплены сверху (`localStorage` — это UI-удобство, не источник
   данных).

4. **Клавиатура.**
   Given фокус в приложении;
   When пользователь нажимает сочетание вызова переключателя;
   Then он открывается, навигация стрелками и Enter работают, фокус возвращается на триггер при
   закрытии, ловушка фокуса корректна (WCAG 2.1 AA).

5. **Негативный сценарий — недоступный проект в URL.**
   Given пользователь вручную вводит `/projects/{чужой-или-несуществующий}/board`;
   When маршрут загружается;
   Then `beforeLoad` даёт **404** до рендера; в переключателе такого проекта нет; из «последних
   посещённых» он вычищается.

6. **Негативный сценарий — потеря доступа во время работы.**
   Given пользователя удалили из приватного проекта, пока у него открыта вкладка;
   When он выполняет следующее действие;
   Then сервер отвечает 404, клиент показывает экран «проект недоступен» с кнопкой «к списку»;
   `permissionsVersion` изменился, `me/permissions` инвалидирован.

7. **Негативный сценарий — архивные проекты.**
   Given архивные проекты;
   When открыт переключатель;
   Then они не показываются по умолчанию, доступны через явный фильтр и помечены визуально.

8. **Заголовок вкладки и хлебные крошки.**
   Given проектный экран;
   When он отрисован;
   Then `document.title` и хлебные крошки содержат ключ и имя проекта (head-менеджмент на маршрут),
   что делает вкладки различимыми при нескольких открытых проектах.

9. **Производительность.**
   Given список доступных проектов;
   When он загружается;
   Then используется отдельный лёгкий эндпоинт (id, key, name, color, status), кешируемый
   `staleTime: 5 min`; переключатель не тянет полные карточки проектов.

10. **a11y и i18n.**
    Given переключатель;
    When он проверяется axe;
    Then 0 нарушений A/AA, `combobox`-семантика с `aria-activedescendant`, объявление результатов в
    live-области, все строки — EN и RU.

## Состояние по коду (2026-09-27)

Серверная половина и переключатель в шапке отгружены. По критериям — что закрыто и чем доказано:

| # | Состояние | Чем держится |
|---|---|---|
| 1 | закрыт | текущий проект читается из совпавших маршрутов (`units/project/lib/utils/project-location.util.ts`), стора «выбранного проекта» нет; стор недавних хранит только id и на данные не влияет. `project-location.util.test.ts` |
| 2 | закрыт с оговоркой | раздел сохраняется (`project-switch-target.util.ts`; `test/routes/project-switcher.test.tsx`, «keeps the section»). Search-параметры при смене проекта **сбрасываются все**: у разделов проекта сегодня нет ни одного параметра, общего для всех проектов (`view`, `sort`), а фильтр состава относится к своему проекту. `retainSearchParams`/`stripSearchParams` не заведены — заводятся вместе с первым общим параметром |
| 3 | закрыт | поиск на сервере (`GET /projects/options?q=`), пауза 300 мс, отмена по `signal`, недавние закреплены сверху. «Последние 5» — только id: визиты этой вкладки пишет гард в стор в памяти (`service/stores/recent-projects.store.ts`), в браузере список живёт через Mantine `useLocalStorage` под ключом **своим у каждого пользователя** (`bc.recent-projects.v1:<userId>`, `recentProjectsStorageKey`) и записывается при открытии переключателя (`use-project-switcher.hook.ts`). На `logged-out` стор в памяти сбрасывается (`app/auth-events.util.ts`, `recentProjects.reset()`), а копию в браузере удаляет сам хук — подписка на шину сессии, потому что удалить запись можно только через хук, которым она записана; переключатель монтируется только при сессии с `userId` (`widgets/project-switcher`). Старый общий ключ `bc.recent-projects.v1` не читается и не удаляется — остаётся в браузерах, где уже был записан. Прямого обращения к Web Storage нет — его запрещает `test/architecture/data-layer-conventions.test.ts`, это гейт инварианта «нет учётных данных в Web Storage», и расширять его ради UI-удобства не стали. Тесты: «asks once per pause», «remembers the visits across a reload» (в хранилище только id), «keeps the list under the signed-in person’s own key», «forgets the remembered list when the session ends», `composition.test.ts` («forgets the projects the tab visited on a sign-out»), стор, util |
| 4 | закрыт | триггер — кнопка, `Mod+Alt+P` по **физической** клавише (раскладка и `⌥` на macOS не мешают; `Mod+K` занят глобальным поиском, `Mod+Shift+P` в Firefox — приватное окно), стрелки + `aria-activedescendant`, Enter, Escape, фокус на триггер. Внутри текстовых полей (`input`, `textarea`, `select`, `contenteditable`) сочетание не ловится — дефолтные `ignoreTags` Mantine: `Ctrl+Alt` на Windows это AltGr, и на раскладках со знаком на AltGr+P шорткат съедал бы ввод («leaves Ctrl+Alt+P to a text field»). Выбор **другого** проекта не возвращает фокус на триггер отложенно: `focusTarget()` Mantine — `setTimeout(…, 0)`, он срабатывал после того, как объявитель маршрута ставил фокус на `h1` новой страницы, и забирал его обратно (доказано прогоном на переходе к проекту с ответом 404; «leaves focus on the heading of the page a switch leads to»). Теперь фокус ставится на триггер синхронно до навигации, а объявитель переносит его на `h1` новой страницы. С закрытием критерия 8 (2026-09-27) имя страницы — «KEY · Name» проекта, поэтому **любой** переход в другой проект — смена страницы, и фокус уходит на её `h1` (`rules/a11y.mdc` §21: так же, как переход по ссылке из списка; читатель слышит «загружена OTH · Other project» и оказывается в начале нового содержимого; триггер с новым проектом — в одном Shift+Tab). Доказано: «moves focus to the heading of the project a switch opens» — падает и при мутации «ключ страницы без адреса» (фокус остаётся на триггере), и при мутации «вернуть отложенный `focusTarget()`». Синхронный фокус на триггер оставлен: он держит фокус, пока грузится другой проект, вместо `<body>`. Оговорка: мутация «убрать `focusTarget()`» тест возврата фокуса **не роняет** — Mantine возвращает фокус и сам; строка оставлена по документации `Combobox` |
| 5 | закрыт | `beforeLoad` даёт 404 до рендера (было с 014-05); гард теперь забывает проект из недавних на 404/403 и запоминает на успехе (`require-project-access-recent.guard.test.ts`); сервер отдаёт в `recent` только видимые id — `test/integration/db/project-list.test.ts`, блок «the switcher offers what the list shows» |
| 6 | закрыт на клиенте, кроме e2e | экран «проект недоступен» с кнопкой «к списку» — через 014-05, критерий 8: `notFoundComponent` у `/projects/$projectId` — `app/ui/project-not-found.component.tsx`, тест `test/routes/project-overview-screen.test.tsx`. **Инвалидация прав закрыта 2026-09-27:** гард `require-project-access.guard.ts` на 404 и 403 помимо `recent.forget` помечает устаревшей запись `QueryKeys.Permissions.mine()` (`GET /me/permissions`, её `ETag` несёт `permissionsVersion`) — не ожидая, экран 404 её не ждёт. Только `mine()`, не `Permissions.all`: отказ по проекту ничего не говорит о чужих правах на экране администрирования. Серверного кеша прав нет (врезка выше), инвалидировать там нечего. Тесты: гард — «marks the reader’s own rights stale on 404/403, and only theirs» + контроль на успехе и на 500 (мутант «`Permissions.all`» роняет «only theirs»); экран — «asks for the reader’s rights again once a project answers «not found»» в `test/routes/project-switcher.test.tsx` (мутант «убрать инвалидацию»: `expected 1 to be greater than 1`). Оговорка: 404 ловится там, где его видит гард, — при входе в маршрут проекта. 404 на запросе **внутри** открытого проекта (состав, мутация) гард не проходит и права не перечитывает. **Открыто:** e2e (`membership-invalidates-permissions.spec.ts`) |
| 7 | закрыт | архив скрыт по умолчанию, переключатель `archived`, пометка словом «В архиве». Сервер: `list-project-options.query.test.ts`, HTTP-набор; клиент: «hides the archive until asked» |
| 8 | закрыт с оговоркой | крошка проекта несёт `title` «KEY · Name» (`units/project/lib/utils/project-title.util.ts`) рядом со своим ключом: `routeCrumbs(matches, titles)` получает заголовки по `routeId`, их собирает `widgets/breadcrumbs/hooks/use-route-crumbs.hook.ts` из карточки в кеше (`useProjectTitle` — тот же выключенный запрос, что у триггера переключателя, **без нового запроса**). Из этой крошки строятся все четыре голоса страницы: `h1` (`PageHeader` получил необязательный `title`), `document.title`, живая область объявителя и сама крошка. Заглушки 404/403/ошибки по-прежнему вытесняют имя проекта (ассерты на `errors.*.title` не менялись, плюс «names a notFound/error by its stand-in, not by the project»). Имя проекта — данные, не перевод: одинаково в EN и RU. Переименование обновляет вкладку и `h1` из кеша без запроса («renames the tab when the card in the cache is renamed»), но **не** живую область объявителя: её текст меняется только тогда же, когда объявитель двигает фокус, — пришла другая страница (`widgets/route-announcer/lib/spoken-page.util.ts`, `spokenPage`). Иначе скринридер объявлял бы переименование как навигацию, а на время загрузки другого проекта — безымянное «Проект» между двумя именами. Вкладка — не живая область: она следует переименованию сразу, а во время загрузки держит имя прежней страницы (`tabPage`). Тесты: «renames the tab after a save without speaking the new name as a new page» (`project-settings-screen.test.tsx`), «says nothing in the live region while the other project loads, then names it» (`project-switcher.test.tsx`) — оба красные до фикса и под мутантами «говорить во время загрузки» / «говорить при той же странице». Ключ «смены страницы» для объявителя — `crumbIdentity`: ключ крошки и **адрес**, а не имя, поэтому другой проект — новая страница (фокус на `h1`, см. п. 4), а переименованный — нет (фокус не выбивается из формы настроек; «stays when the same project is renamed», мутант «ключ по имени» роняет его). Кеш читается только после `success` макета проекта: подписка наблюдателя во время запроса гарда под `StrictMode` отменяла этот запрос TanStack Query (последний наблюдатель ушёл) — **замерено**, два теста неудачной загрузки в `project-overview-screen.test.tsx` краснели. **Оговорка:** сама цепочка крошек на экране проекта не рисуется — у `/projects/$projectId` нет родителя с крошкой (`projects/index.tsx` — сосед, а не макет), крошка одна, а одна крошка не рендерится по правилу виджета. То же у всех страниц продукта сегодня. Видимая цепочка «Проекты / KEY · Name» требует макет-маршрута `projects/route.tsx` с крошкой списка — решение не принято |
| 9 | закрыт | `GET /projects/options` — пять полей, без счётчиков и фасетов, до 50 строк + `hasMore`; `staleTime` 5 минут (`project-options.query.ts`); видимость — тот же план и тот же SQL-префикс, что у списка (`project-list-viewer.util.ts`, `project-list-query.adapter.ts`) |
| 10 | закрыт | axe на открытом списке без нарушений, счётчик в `role="status"`, EN и RU в `nav.json` (`projectSwitcher.*`) |

Серверные решения: отдельный лёгкий маршрут, а не узкая форма `GET /projects` — список считает
участников подзапросом на строку и фасеты вторым оператором, переключателю это не нужно. Второго
механизма видимости нет: чтение узла организации и план вынесены в
`application/project/project-list-viewer.util.ts`, им пользуются оба запроса. Маршрут стоит **до**
`/projects/:projectId`. В снапшоте матрицы — по ячейке на роль, совпадают с `GET /projects`.

e2e `project-switcher.spec.ts` не написан — зона агента e2e.

## Задачи

- [x] Переключатель: `widgets/project-switcher/project-switcher.widget.tsx` (читает маршрут,
      навигирует) + `units/project/ui/project-switcher.component.tsx`,
      `ui/project-switcher-option.component.tsx` (Mantine `Combobox` с поиском в выпадающем списке,
      API сверен через MCP `mantine`).
- [x] `units/project/service/queries/project-options.query.ts`,
      `service/hooks/use-project-switcher.hook.ts`.
- [x] `units/project/lib/utils/recent-projects.util.ts` (чистые функции) +
      `service/stores/recent-projects.store.ts` (стор, потому что пишет гард `beforeLoad`; в браузер
      список уходит через Mantine `useLocalStorage` в хуке).
- [ ] `retainSearchParams` / `stripSearchParams` — не нужны до первого общего параметра (критерий 2).
- [x] Размещение в шапке — `widgets/app-shell/ui/topbar.component.tsx` (`widgets/app-header` в дереве нет).
- [x] Хлебные крошки и заголовок вкладки с ключом и именем проекта (критерий 8; видимая цепочка
      ждёт макет-маршрута над списком — см. таблицу).
- [x] Инвалидация `me/permissions` на 404/403 проекта (критерий 6, клиентская половина).
- [x] `application/project/use-cases/list-project-options.query.ts` + запись в реестре с
      `project:read`, `aclCheckedIn: 'ListProjectOptionsQuery'`; контракт и `pnpm api:gen`.
- [x] i18n: `shared/i18n/locales/{en,ru}/nav.json`.
- [x] Тесты: сервер — юнит запроса и адаптера, HTTP, матрица, интеграционный на живом Postgres;
      клиент — util, стор, гард, экран целиком (`test/routes/project-switcher.test.tsx`) с клавиатурой и axe.
- [ ] e2e `project-switcher.spec.ts` (п. 1, 2, 5) + axe.

## Ссылки

- [`ux-architecture.md`, «Глобальный поиск и переключатель проекта», «Принцип 1: состояние экрана
  всегда восстанавливается из URL», «Фокус», «Клавиатурный канбан»](../../../docs/architecture/ux-architecture.md)
- [`permission-model.md` §6 (наследование), §5 fail-closed (404)](../../../docs/security/permission-model.md)
- [`threat-model.md`, `T-PROJ-01`](../../../docs/security/threat-model.md)
- CLAUDE.md, блок 🎨-H (TanStack Router: `retainSearchParams`, `stripSearchParams`, `defaultPreload`)

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
