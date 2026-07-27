---
id: STORY-004-01
epic: EPIC-004
status: in-progress
blocked: false
priority: must
estimate: M
---

# STORY-004-01 — Vite, React 19, strict TS и алиасы слоёв

**Как** разработчик Bad CRM **я хочу** настроенный клиентский пакет с React 19, строгим TypeScript и
алиасами по слоям **чтобы** писать импорты вида `@units/auth` вместо `../../../` и получать ошибки
типов до запуска.

## Acceptance (Given/When/Then)

- **Given** `pnpm --filter @bad-crm/client dev` **When** открываю `http://localhost:5173` **Then** отрисовывается корневой компонент, HMR работает: правка `.tsx` применяется без полной перезагрузки.
- **Given** импорт `@shared/lib/format` **When** запускаю `tsc --noEmit`, `vite build` и `vitest` **Then** все три резолвят алиас одинаково (значения объявлены в `tsconfig.json`, `vite.config.ts` и конфиге тестов из единого источника).
- **Given** переменная окружения без префикса `VITE_` **When** пытаюсь обратиться к ней в клиентском коде **Then** ESLint-правило падает: в бандл могут попадать только `VITE_*`, серверные секреты — никогда.
- **Given** production-сборка **When** выполняю `vite build` и смотрю отчёт **Then** сборка проходит без предупреждений о размере сверх бюджета; настроен `size-limit` с бюджетом на начальный чанк маршрута (300 КБ gzip).
- **Given** React 19 **When** запускаю приложение в dev **Then** включён `StrictMode`, и двойной вызов эффектов не приводит к дублированию запросов (эффектов, делающих запросы, нет — данные идут через TanStack Query).
- **Given** файл `user-card.component.tsx` с двумя экспортируемыми компонентами **When** запускаю линт **Then** правило «один компонент — один файл» падает.
- **Given** имя файла `UserCard.tsx` **When** запускаю линт имён **Then** он падает: файлы именуются kebab-case с role-суффиксом.

## Задачи

- [x] **Достроить CSP под реальный браузерный рендер** (пробел [ADR-0023](../../../docs/architecture/adr/0023-csp-for-wasm-crypto.md),
      найден при ревью EPIC-003). Сейчас `style-src 'self'` заблокирует Mantine: UI-kit раздаёт
      CSS-переменные инлайновым атрибутом `style=""`, а `style-src-attr` наследуется от `style-src`.
      Решение — **не** `style-src 'unsafe-inline'`, а раздельные `style-src-elem` с nonce и
      `style-src-attr 'unsafe-inline'`. Плюс добавить origin хранилища в `media-src` и `frame-src`
      (видео/аудио-вложения и предпросмотр PDF иначе упрутся в `default-src 'self'`).
      Проверяется **в браузере**, а не тестом на строку политики: обе ошибки дают зелёный тест.
      Правится `packages/server/src/presentation/http/content-security-policy.util.ts`, обновляется
      ADR-0023 и `docs/security/e2ee-design.md` §12.
      **Сделано, и браузер поправил само решение.** Измерено на production-сборке React 19 +
      Mantine 7 под этим заголовком: (1) `style-src-attr 'unsafe-inline'` **не нужен** — React
      применяет `style` через CSSOM, а CSP регулирует парсинг атрибута, поэтому стоит
      `style-src-attr 'none'`; (2) `<style>`-элементы Mantine действительно нужно пускать по nonce
      (`style-src-elem`), Mantine принимает его через `getStyleNonce`; (3) найден третий дефект,
      которого не было в пробеле: `require-trusted-types-for 'script'` роняет монтирование React
      целиком (пустая страница), поэтому добавлено `trusted-types default` и требование к клиенту
      установить единственную политику. `media-src`/`frame-src` добавлены. Подробности и таблица
      измерений — в ADR-0023 и §12. Генерация nonce на запрос — за историей, где сервер начинает
      отдавать `index.html`.

- [x] Написать тесты первыми: `test/config/aliases.test.ts` (совпадение алиасов в трёх конфигах), `test/config/naming.test.ts` (kebab-case + role-суффиксы по всему `src/**`), `test/config/env-prefix.test.ts` (нет обращений к не-`VITE_` переменным).
      Разложились иначе: алиасы — `test/repo/client-aliases.test.ts` (три конфига как данные) плюс
      `packages/client/test/config/aliases.test.ts` (резолвятся в рантайме); имена — общий тест
      дерева `test/architecture/structure.test.ts` и фикстуры `test/lint`; префикс `VITE_` — уже
      существующий `packages/client/test/config/env.test.ts` плюс фикстура
      `use-api-url.hook.ts` (запрет `import.meta.env` вне `shared/config`).
- [x] Создать `packages/client` с `vite.config.ts` (плагины `@vitejs/plugin-react`, `vite-tsconfig-paths` либо явный `resolve.alias`), `index.html`, `src/app/main.tsx`.
      Явный `resolve.alias`: плагин читал бы `tsconfig` и сделал бы расхождение невозможным, но
      вместе с ним — и непроверяемым, а история требует именно проверки двух объявлений.
- [x] Настроить единый источник алиасов (`config/aliases.ts`), из которого читают и `vite.config.ts`, и тесты; `tsconfig.json` синхронизируется тестом.
      Лежит в `src/shared/config/fsd-aliases.constant.ts` — внутри дерева, которое уже покрыто
      ESLint, `inputs` турбо и coverage; список из `test/repo/tsconfig-contract.test.ts` удалён,
      чтобы не было третьего источника правды.
- [x] Настроить `vitest` с `environment: jsdom`, `@testing-library/react`, `setupFiles` для матчеров и очистки.
- [x] Настроить `size-limit` с бюджетом начального чанка и отдельной строкой-исключением для крипто-чанка vault (появится в M7).
      Бюджет взят из `ux-architecture.md` (250 KB gzip), а не из текста этой истории (250 KB (по `docs/architecture/ux-architecture.md`)) —
      расхождение вынесено в отчёт: `docs/` выше `epics/`, и более строгая цифра ничего не прячет.
- [x] Добавить ESLint-правила именования файлов и «один компонент на файл» (`unicorn/filename-case` + собственное правило/тест).
      Правила были с EPIC-001; здесь проверено, что они реально применяются к настоящему дереву
      (`ESLint.calculateConfigForFile` по реальным путям в `test/lint/architecture-rules.test.ts`).
- [x] Настроить `vite preview` и добавить скрипт `pnpm --filter @bad-crm/client preview` для проверки production-сборки.

## Definition of Done

- [x] Тесты написаны первыми (TDD), проходят, изменённый код покрыт — `packages/client` 100 % строк
      и ветвей, `coverage-baseline.json` подтянут вверх
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`) — ADR-0023 и `e2ee-design.md` §12
      обновлены; запись журнала `docs/brain/` не создавалась
- [x] a11y-проверка (для UI-историй) — базовая разметка `index.html` (`lang`, `title`) проверена
- [x] i18n: строки в обоих языках, хардкода нет (для UI-историй) — на этом этапе UI-строк нет
      (продуктовое имя и ключ перевода в качестве текста-заглушки)

## Ссылки

- Документация: [`ux-architecture.md` → Адаптивность и производительность](../../../docs/architecture/ux-architecture.md), [`stack.md` → Клиент](../../../docs/architecture/stack.md)
- Правила: `rules/frontend-fsd.mdc`, `rules/naming-and-structure.mdc`
