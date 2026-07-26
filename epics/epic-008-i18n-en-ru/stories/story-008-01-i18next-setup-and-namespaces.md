---
id: STORY-008-01
epic: EPIC-008
status: backlog
blocked: false
priority: must
estimate: M
---

# STORY-008-01 — i18next, namespace и провайдер

**Как** разработчик Bad CRM **я хочу** настроенную инфраструктуру локализации с раскладкой по
namespace **чтобы** строки жили рядом со своим доменом и грузились вместе с чанком маршрута, а не
одним мегафайлом на старте.

## Acceptance (Given/When/Then)

- **Given** приложение с провайдером i18n **When** оно загружается **Then** сразу доступны namespace `common` и `validation`; доменные namespace (`auth`, `nav`, `admin` и т. д.) подгружаются лениво вместе с чанком маршрута.
- **Given** компонент, использующий `t('common.action.save')` **When** локаль `ru` **Then** отображается «Сохранить»; при `en` — «Save».
- **Given** отсутствующий ключ **When** он запрашивается **Then** в dev выводится предупреждение с именем ключа и namespace, а в UI показывается сам ключ (а не пустая строка), чтобы пропуск был заметен.
- **Given** ключ, собранный конкатенацией в рантайме **When** запускается линт **Then** он падает: ключи должны быть статически находимыми.
- **Given** структура ключей **When** смотрю файл **Then** ключи иерархические и семантические (`tasks.board.column.empty.title`), а не по тексту (`tasks.click_here`) — проверяется тестом формата.
- **Given** множественное число на русском **When** значение равно 1, 3 и 11 **Then** используются формы `one`, `few`, `many` соответственно; тест покрывает все три и ноль.
- **Given** переключение локали **When** оно происходит **Then** уже загруженные namespace переключаются мгновенно, а недостающие подгружаются; перезагрузка страницы не требуется.
- **Given** сборка **When** она выполняется **Then** файлы локалей не попадают целиком в начальный бандл — проверяется бюджетом размера.

## Задачи

- [ ] Написать тесты первыми: `shared/i18n/i18n.test.ts` (инициализация, дефолтные namespace, поведение при отсутствующем ключе), `shared/i18n/plural.test.ts` (формы для ru и en, включая ноль), `test/lint/i18n-keys-format.test.ts`.
- [ ] Реализовать `src/shared/i18n/i18n.ts` — конфигурация `i18next` (`fallbackLng: 'en'`, `defaultNS: 'common'`, `ns` по умолчанию, `interpolation.escapeValue: false` для React).
- [ ] Создать структуру `src/shared/i18n/locales/{en,ru}/` с файлами `common.json`, `validation.json`, `errors.json`, `nav.json`, `auth.json` (остальные namespace добавляются доменными эпиками).
- [ ] Реализовать ленивую загрузку namespace вместе с чанком маршрута (`useTranslation('auth')` + backend-загрузчик или статические динамические импорты).
- [ ] Подключить `I18nextProvider` в `src/app/providers.tsx` до `MantineProvider` и обеспечить доступность `t` во всех слоях UI.
- [ ] Заполнить `common.json` и `validation.json` базовым набором (действия, состояния, единицы, тексты ошибок Zod) на обоих языках.
- [ ] Настроить перевод сообщений Zod через единый мап (используется `mantine-form-zod-resolver`).
- [ ] Добавить типизацию ключей (`resources` в декларации модуля i18next), чтобы неизвестный ключ был ошибкой компиляции.

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y-проверка: `<html lang>` соответствует активной локали
- [ ] i18n: строки в обоих языках, хардкода нет

## Ссылки

- Документация: [`ux-architecture.md` → Раскладка namespace, Плюрализация](../../../docs/architecture/ux-architecture.md), [ADR-0019](../../../docs/architecture/adr/0019-i18n-en-ru-i18next.md)
- Правила: `rules/i18n.mdc`, `rules/frontend-fsd.mdc`
