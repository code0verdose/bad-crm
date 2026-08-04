---
date: 2026-08-05
project: bad-crm
tags: [react, vite, motion, lenis, ogl, eslint, vitest, i18n, a11y, licensing]
---

# Что коммит-гейт нашёл в лендинге

Продолжение [[2026-08-04--the-landing-that-is-not-the-product]]: страница была готова, а к коммиту
её готовили отдельно. Гейт из шести проверок дал два FAIL и один PASS с оговорками — и почти всё
найденное было невидимо на экране.

## Простым языком

1. **Страница целиком падала в двух ситуациях, которых у меня на машине не бывает.** Если в браузере
   выключен WebGL (политика компании, виртуалка, Firefox с `webgl.disabled`), библиотека фона кидала
   ошибку прямо из конструктора — а ошибка внутри эффекта React уносит всё приложение: вместо сайта
   белый экран из-за декоративного градиента. То же самое со заблокированным хранилищем: язык и ответ
   про куки читаются в первый же рендер, и `SecurityError` там означал не «забудем настройку», а
   «сайта нет». Теперь фон молча не появляется, а настройки просто не переживают перезагрузку.
2. **Русская версия местами говорила по-английски.** В иллюстрациях справа были вписаны прямо в
   разметку слова `Discovery`, `Backlog`, `5 containers`, `yours`, `15.0 h`, аватар в чате с
   ассистентом — `YOU`. Всё это переехало в словарь, где и лежит остальной текст: расхождение языков
   теперь ловит компилятор, а не глаз.
3. **Кнопка «Read the source» вела в никуда** — адрес репозитория был выдуман (`badcrm/bad-crm`), а
   настоящий лежит в `NOTICE` и `README`. Шесть кнопок на странице, все шесть — 404.
4. **Мы обещали в четырёх файлах, что атрибуция чужого кода записана в `NOTICE`, и не записали её.**
   Код React Bits скопирован в репозиторий, а не подключён пакетом, поэтому его лицензия с
   `node_modules` не приезжает: обязанность по MIT — наша. Добавил раздел «Vendored source».
5. **Якоря в шапке не работали со страниц политик** — на них ссылка вида `#security` указывает на
   раздел *текущего* документа, которого там нет. Теперь ссылка абсолютная (`/#security`), а после
   возврата на главную страница ждёт, пока раздел появится и высокие «пришпиленные» сцены наберут
   свою высоту, и только потом встаёт на него.
6. **Запрет сети в лендинге легко обходился.** Правило ловило голое `fetch`, а пакет по своему стилю
   пишет `globalThis.fetch` — то есть главное обещание страницы («ничего из введённого не уходит
   наружу») держалось на правиле, которое этого не проверяло.
7. **`pnpm dev` незаметно стал поднимать три приложения** — занятый порт лендинга ронял запуск всем,
   кто лендинг не трогает. Лендинг выведен в отдельную команду.

## Технически

1. `packages/landing/src/shared/ui/bits/aurora/aurora.component.tsx:133` — `new Renderer(...)` в
   `try/catch` плюс проверка `renderer.gl`; в `ogl@1.0.11` конструктор делает
   `this.gl.renderer = this` при `getContext → null` и бросает `TypeError`.
2. `packages/landing/src/shared/lib/storage.util.ts` — единственная точка доступа к `localStorage`,
   три обёртки с `try/catch`; переведены `app/i18n/locale.provider.tsx` и `shared/lib/consent.util.ts`.
3. Копирайтинг иллюстраций: `domains.preview` и `invariants.visual` в обоих словарях;
   `domain-preview.component.tsx` и `invariant-visual.component.tsx` стали компонентами с
   `useLocale()` (были модульные константы), геометрия (`MILESTONE_PROGRESS`, `WEEK_HOURS`,
   `FILE_TYPES`) осталась в модуле — это не язык.
4. `shared/lib/site-links.constant.ts:15` — `GITHUB_URL` → `https://github.com/code0verdose/bad-crm`.
5. `NOTICE` — раздел «Vendored source»: React Bits (MIT, © David Haz) и Simple Icons (CC0-1.0).
6. `shared/ui/section-link.component.tsx` + `shared/lib/smooth-scroll.util.ts`: href всегда
   `/#<id>`; вне главной — `preventDefault`, `navigate(ROUTES.home)`, затем повтор по таймеру, пока
   `getBoundingClientRect().top` не окажется у нуля (высокие sticky-сцены доопределяют высоту после
   монтирования). Скролл идёт через Lenis (`scrollTo(el, { immediate: true })`), а без него —
   `scrollIntoView`. Таймер вместо `requestAnimationFrame`: фоновая вкладка кадров не выдаёт.
   `pages/legal/legal-page.component.tsx` получил `id={SECTION_IDS.main}` — иначе skip-link на
   юридических страницах вёл в пустоту.
7. `eslint.config.js` — к `no-restricted-globals` добавлены `no-restricted-properties`
   (`globalThis|window|self` × `fetch|XMLHttpRequest|WebSocket|EventSource`, `navigator.sendBeacon`)
   и `no-restricted-syntax` на `import('https://…')`; фикстуры
   `test/lint/fixtures/packages/landing/**` (два негативных случая и положительный контроль).
8. `app/providers.tsx` — `MotionConfig reducedMotion="user"`: CSS-килсвитч не достаёт до входных
   анимаций `motion`, они инлайновые стили.
9. `widgets/cookie-banner.widget.tsx:35` — `role="region"` вместо `role="dialog"`: баннер не
   модальный, фокус в него не переводится, и объявлять диалог означало врать скринридеру.
10. `sections/demo/participants.util.ts` — уникальные участники для строки присутствия; было
    `key={message.author}` по списку сообщений, где Нина пишет дважды.
11. Регистрация пакета там, где его не видели гейты: `test/repo/repo-fixture.util.ts`
    (`PACKAGE_DIRS`/`PACKAGE_NAMES` → +5 контрактных проверок), `coverage-baseline.json`,
    `WORKSPACE_MANIFESTS` в `.github/workflows/license-check.yml`, исключение с обоснованием в
    `test/repo/coverage-contract.test.ts`.
12. `package.json` — `dev` получил `--filter=!@bad-crm/landing`, добавлен `dev:landing`; таблицы
    команд в `CLAUDE.md` и `docs/architecture/stack.md` обновлены. Версии инструментов лендинга
    выровнены с клиентом (`vite 8.2.0`, `jsdom 30.0.1`, `@vitejs/plugin-react 6.0.5`,
    `@types/react 19.2.18`, `size-limit 13.0.3`) — иначе в сторе жили две сборочные цепочки.

## Отдельно: как чуть не потерялся словарь

Правка словарей скриптом с `re.sub(..., flags=re.S)` и шаблоном `items: \[.*?visuals:` зацепилась за
первый `items:` в файле и снесла ~150 строк копирайтинга в обоих языках. Пакет не был в git —
отката не существовало. Восстановлено из `packages/landing/dist/assets/index-*.js.map`: Vite кладёт
в карту `sourcesContent`, то есть полный исходник на момент последней сборки.

**Вывод, который стоит запомнить:** пока пакет untracked, любая правка скриптом необратима.
Регулярка по многострочному тексту должна быть привязана к обеим границам (`^  ключ: {` … `^  },`),
а не к «первому попавшемуся» открывающему токену.

## Применённые технологии

- [[React]] 19, [[Vite]], [[Motion]], [[Lenis]], [[OGL]], [[CSS Modules]], [[Vitest]], [[ESLint]]
- [[Stylelint]] — правила лендинга и их синхронный тест
- [[React Bits]] — вендоренный MIT-код и обязательства по атрибуции

## Связи

- Проект: [[Projects/bad-crm]]
- Related: [[2026-08-04--the-landing-that-is-not-the-product]], [[Concepts/frontend-architecture]]
