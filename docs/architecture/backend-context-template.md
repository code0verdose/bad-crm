# Шаблон нового backend-контекста

Как добавить контекст (домен) на сервере, чтобы он выглядел как все остальные. Раскладка выведена из
[`stack.md` → Backend: гексагональная архитектура](./stack.md) и зафиксирована в
[`rules/hexagonal-backend.mdc`](../../rules/hexagonal-backend.mdc); имена файлов — в
[`rules/naming-and-structure.mdc`](../../rules/naming-and-structure.mdc).

Эталон, который можно копировать целиком, — контекст `platform` (health/readiness), написанный в
EPIC-003 именно как образец: он проходит весь путь `controller → use-case → port → adapter`, не имеет
ни одной зависимости на инфраструктуру выше `main.ts` и покрыт тестами всех уровней.

## Каталоги

```
packages/server/src/
  domain/<context>/
    <entity>.entity.ts          # инварианты сущности
    <value>.value.ts            # value-object
    <context>.errors.ts         # доменные ошибки контекста (база — domain/shared/errors)
    access/<name>.policy.ts     # решение о доступе: чистая функция, 100 % покрытие
  application/<context>/
    ports/<name>.port.ts        # интерфейсы, которые нужны use-case'ам — объявляются ЗДЕСЬ
    use-cases/<name>.use-case.ts   # команда: меняет состояние, одна транзакция
    use-cases/<name>.query.ts      # чтение: read-модель, транзакции не открывает
  infrastructure/<context>/
    <name>.adapter.ts           # реализация порта
    persistence/prisma/<name>.repository.ts
  presentation/http/
    controllers/<context>.controller.ts
    validators/<name>.validator.ts
    serializers/<context>.serializer.ts
```

Пустые сегменты не создаются: каталог появляется вместе с первым файлом в нём.

## Обязательные правила (проверяются автоматически)

| Правило | Где проверяется |
|---|---|
| `domain` не импортирует `application`/`infrastructure`/`presentation`, Node-модули, Prisma, Express | ESLint + `test/unit/architecture/layers.test.ts` |
| `application` не импортирует `infrastructure`/`presentation` | там же |
| `presentation` не импортирует `infrastructure` (адаптеры связывает composition root) | там же |
| Порт объявлен в `application/<context>/ports/`, адаптер — в `infrastructure/**` | `layers.test.ts` |
| Контроллер не импортирует репозиторий | `layers.test.ts` |
| `*.query.ts` не меняет состояние | `test/unit/architecture/naming.test.ts` |
| Имя файла — kebab-case + суффикс из закрытого словаря | ESLint `bad-crm/require-role-suffix` + `naming.test.ts` |
| Нет `asyncHandler`, нет `try/catch` в контроллерах, нет безымянных wildcard-маршрутов | `test/unit/architecture/express-conventions.test.ts` |
| Импорты через `@/*`, без `../` | ESLint + `layers.test.ts` |

Единственное задокументированное исключение: `infrastructure/bootstrap/**` — это composition root,
он **имеет право** знать и об адаптерах, и о `presentation`, и читать `process.env`.

## Порядок работы

1. **Термины** — имя контекста и сущностей берётся из
   [`glossary.md`](../product/glossary.md) (единственное число, без синонимов).
2. **domain** — сущность с инвариантами и policy; юнит-тесты без окружения (порог 95 %/90 %, policy —
   100 %).
3. **application** — порты, затем use-case; тесты с in-memory реализациями портов, без БД.
4. **infrastructure** — адаптеры под порты; contract-тест на каждый адаптер внешнего сервиса.
5. **presentation** — валидатор, тонкий контроллер, сериализатор; регистрация маршрута в
   `api.routes.ts`.
6. **composition root** — сборка в `infrastructure/bootstrap/container.factory.ts`; новый ресурс,
   который надо закрывать, добавляется в `shutdownSteps`.
7. **Контракт** — операция в `docs/api/openapi.yaml` (STORY-003-05) и коды ошибок из
   `packages/shared`.

## Чек-лист перед коммитом

- [ ] Права: endpoint объявляет permission из каталога, проверка — в use-case через policy.
- [ ] Мультиарендность: новая таблица — `organization_id`, RLS `ENABLE`+`FORCE`, `USING`+`WITH CHECK`,
      isolation-тест с положительным контролем.
- [ ] Отказ в доступе строится через `denyAccess(...)` (`domain/shared/errors/access-denial.util.ts`),
      а не подбором статуса на месте: чужая организация — 404, не 403.
- [ ] Логи: идентификаторы и размеры, ноль секретов и пользовательского содержимого.
- [ ] Новый закрываемый ресурс зарегистрирован в graceful shutdown.
