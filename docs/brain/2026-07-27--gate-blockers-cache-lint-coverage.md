---
date: 2026-07-27
project: bad-crm
tags: [turborepo, vitest, eslint, typescript, zod, prettier, pnpm]
---

# Блокеры commit-гейта EPIC-001: кеш turbo, слепой линт, неизмеряемое покрытие

## Простым языком

1. **Починил кеш turbo, который выключал единственную проверку окружения.** Задача `//#test:repo`
   перечисляла файлы, за которыми следит, и в этом списке не было исходников пакетов и `.gitignore`.
   А проверка «`.env.example` совпадает со схемами окружения» читает именно их. Значит, можно было
   добавить переменную в схему, забыть в шаблоне — turbo отдал бы старый зелёный результат, и
   администратор self-host словил бы падение на переменной, о которой ему не сказали.
2. **Заставил `pnpm lint` линтовать каталог `test/`.** Turbo обходит только пакеты, у которых есть
   свой скрипт `lint`; корневой каталог `test/` (половина всех тестов) не проверялся никем. Из-за
   этого запрет на `describe.only` был объявлен, но не работал — один забытый `.only` тихо
   превращал 183 теста в 3 при зелёном гейте. Добавил корневую задачу линта. Она сразу же нашла
   реальные дефекты: сырые нулевые байты в исходнике и семь ошибок правил vitest.
3. **Включил измерение покрытия тестами.** Turbo обещал складывать отчёт в `coverage/`, но провайдера
   не было ни в одном пакете — пороги из правил тестирования существовали только на бумаге.
   Подключил провайдер, прописал пороги по нормативу и дописал тесты на непокрытые ветки.
4. **Привёл README и CHANGELOG в соответствие с кодом.** Они утверждали, что нет `docker-compose.yml`,
   нет `.env.example` и что `pnpm lint` ничего не делает — всё это добавлено этим же коммитом.
   В CHANGELOG появился раздел про EPIC-001 с полным перечнем переменных окружения.
5. **Синхронизировал статусы историй с кодом** и зафиксировал одно отклонение от плана: роли БД
   сделаны раньше, чем предполагала история.
6. **Мелкие дыры рядом:** тесты на непокрытые ветки, отсутствующая типизация тестов у двух пакетов,
   слишком широкие исключения в ESLint, слабая валидация адреса API у клиента, две лицензии вне
   allow-list.

## Технически

1. `turbo.json` — в `inputs` задачи `//#test:repo` добавлены `packages/*/src/**` и `.gitignore`;
   добавлен `outputs: ["coverage/**"]`. Доказано хешем задачи (`turbo run test:repo --dry=json
   --no-daemon`): до правки `5bd0474ea03898ce` не менялся при изменении
   `packages/server/src/infrastructure/bootstrap/env.schema.ts`; после правки меняется на
   `c6cf0d73f977613b`, а при изменении `.gitignore` — на `55a18f48cb5da54f`. Остальные задачи
   проверены тем же способом (10 проб по классам файлов) — у них `$TURBO_DEFAULT$`, дефектов нет.
   `--no-daemon` обязателен: демон отдаёт закешированные хеши файлов и даёт ложный результат.
2. `turbo.json` + `package.json` — корневая задача `//#lint:repo` и скрипт
   `eslint . --ignore-pattern packages/ --max-warnings 0`; `lint` получил `dependsOn: ["^build",
   "//#lint:repo"]` по образцу `test` → `//#test:repo`. Имя `lint:repo`, а не `lint`: корневой
   скрипт `lint` уже занят `turbo run lint`, и turbo отвергает root-задачу, вызывающую саму себя.
   Доказано: с `describe.only` в `test/repo/workspace-layout.test.ts` `pnpm lint` теперь падает
   (`vitest/no-focused-tests`, exit 1), до правки — `exit 0, FULL TURBO`.
3. `eslint.config.js` — `vitest/valid-expect` с `maxArgs: 2` (Vitest поддерживает
   `expect(actual, message)`, правило по умолчанию считает по Jest) и `vitest/valid-title` с
   `ignoreTypeOfDescribeName: true` (`describeForbidden(title, cases)` строит suite'ы из таблицы).
4. `test/infra/compose-fixture.util.ts:120,131` — сырые байты `\x00` заменены на escape `\u0000`
   плюс точечный `eslint-disable-next-line no-control-regex` с обоснованием. Сырой NUL заставляет
   git считать файл бинарным и не переживает round-trip через редактор или патч.
5. Покрытие: `@vitest/coverage-v8@4.1.10` в корне и в `shared`/`server`/`client`; в каждом
   `vitest.config.ts` — `coverage.enabled`, `provider: 'v8'`, `include: ['src/**']`,
   `reporter: ['text-summary', 'json-summary', 'lcovonly']` и `thresholds` по
   `rules/testing.mdc` §7: server 85/80 плюс глобы `src/domain/**` 95/90,
   `src/domain/**/access/*.policy.ts` 100/100, `src/application/**` 90/85,
   `src/infrastructure/**` и `src/presentation/**` 75/70; client 70/60; shared 95/90 плюс
   `src/permissions/**` 100/100 (в §7 строки для `shared` нет — взят domain-tier, `can.util.ts` —
   policy по сути); корень 75/70 над `test/**/*.util.ts`. `lcovonly`, а не `lcov`: HTML-отчёт
   тянет за собой `prettify.js` с `debugger` и `console.log(`, которые ловит `scan-cruft.sh`.
6. Тесты на непокрытые ветки: `money.util.ts:15` (`!Number.isFinite` — NaN/±Infinity),
   `env.errors.ts:11` (issue без `path` → `<root>`), `env.schema.ts:69` (`catch` в `isBase64Bytes`,
   вход `'AAAAA'`: валидные символы, длина не кратна кванту base64 → `atob` бросает
   `InvalidCharacterError`). Плюс 20 ассертов на `ARGON2_*` и `CORS_EXTRA_ORIGINS`.
   Итог: shared 100/100, server 97.0 строк / 100 ветвей, client 90.9/100, корень 97.6/84.4.
7. `test/infra/compose-fixture.test.ts` — 28 тестов на чистые хелперы compose-фикстуры
   (`splitPortMapping`, `hostInterfaceOf`, `publishedPortOf`, `environmentOf`, `imageMajorOf`,
   `healthcheckCommandOf`, `namedVolumesOf`, `alwaysOnServices`). Без них `compose.test.ts`
   мог проходить вхолостую: неверный `hostInterfaceOf` делает вакуумным запрет публикации
   Postgres на `0.0.0.0`.
8. `packages/server/tsconfig.test.json`, `packages/client/tsconfig.test.json` + `typecheck` →
   `tsc --noEmit && tsc -p tsconfig.test.json`. Раньше `include: ["src/**"]` оставлял тесты вне
   программы, из-за чего `@ts-expect-error`-гарантии не проверялись. `@types/node` добавлен клиенту
   (нужен для `vitest.config.ts`).
9. `eslint.config.js:475-483` — `'no-restricted-globals': 'off'` для `shared/api/**` заменён на
   переобъявление без `fetch`, но с `XMLHttpRequest` и новым `NO_PERSISTENT_TOKEN_STORAGE`
   (`localStorage`/`sessionStorage`); `'no-restricted-syntax': 'off'` для `shared/config/**` — на
   `['error', ...QUERY_HOOK_CALLS]`. Две новые фикстуры и кейсы в
   `test/lint/architecture-rules.test.ts` («layer exceptions stay narrow»).
10. `packages/client/src/shared/config/env.schema.ts` — `VITE_API_BASE_URL` вместо `.min(1)`
    валидируется предикатом «путь того же origin или абсолютный `http(s)`-URL». Ключевой кейс —
    `//evil.example.com/api`: начинается со слэша, но браузер читает его как чужой origin.
11. `rules/dependencies.mdc:41` — в allow-list добавлены `BlueOak-1.0.0` (`minimatch@10` из
    `eslint`) и `CC-BY-4.0` (`caniuse-lite` из `browserslist`), обе только как транзитивные
    dev-зависимости, с обоснованием совместимости с AGPL-3.0.
12. `README.md`, `README.ru.md`, `CHANGELOG.md`, `docs/runbooks/upgrade.md` — приведены к
    фактическому состоянию; в `## [Unreleased]` добавлены разделы «Added — EPIC-001» и
    «Environment variables — EPIC-001» (45 переменных: 9 обязательных, 17 опциональных с
    дефолтами, 1 клиентская, 18 только для compose).
13. `epics/epic-001-.../stories/story-001-0{3,4,5,7}` → `status: in-progress`; в `story-001-04`
    добавлен раздел «Отклонения от плана» про роли БД; борд пересобран `sync-board.sh`.
14. `test/repo/coverage-contract.test.ts` (новый) и дополнения в
    `test/repo/workspace-layout.test.ts` / `tsconfig-contract.test.ts` — метатесты, которые роняют
    сборку, если пороги, `inputs` или тестовые tsconfig-проекты снова исчезнут.

## Применённые технологии

- [[Turborepo]] — `inputs` как allow-list, root-задачи `//#task`, `--dry=json` для аудита хешей.
- [[Vitest]] — `coverage.thresholds` с глоб-ключами, `reportOnFailure`, таймауты на `it.each`.
- [[ESLint]] — flat config, переобъявление правил вместо `off`, `@vitest/eslint-plugin`.
- [[TypeScript]] — отдельный проект для тестов (`tsconfig.test.json`), project references.
- [[Zod]] — `.refine` на границе конфигурации вместо `.min(1)`.
- [[Prettier]] — `format:check` доведён до зелёного (был красным до этой работы).

## Связи

- Проект: [[Projects/bad-crm]]
- Related: [[2026-07-27--flow-tooling-and-baseline-commit]], `rules/testing.mdc`,
  `rules/dependencies.mdc`, `rules/tdd-and-commit-gate.mdc`
