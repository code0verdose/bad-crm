---
id: STORY-048-01
epic: EPIC-048
status: backlog
blocked: false
priority: must
estimate: L
---

# STORY-048-01 — Транспорт, каркас адаптера и манифест инструментов

**Как** владелец инсталляции **я хочу** включаемый MCP-эндпоинт с описанным каталогом инструментов
**чтобы** внешние агенты могли подключаться к моей установке, а я — точно знать, что им доступно.

## Acceptance (Given/When/Then)

- **Given** установка без `MCP_ENABLED=true` **When** клиент обращается к `POST /mcp` **Then** маршрут
  не смонтирован (404), ни один MCP-порт не резолвится, и ни один сценарий продукта не деградирует.
- **Given** включённый канал **When** клиент выполняет `initialize` **Then** сервер отвечает по
  Streamable HTTP, объявляя capability `tools`, и не объявляет тех, которых не реализует.
- **Given** обработчик инструмента **When** он написан **Then** он не импортирует `@/infrastructure/**`,
  не обращается к `prisma.*` и не принимает решение о доступе — вызывает use-case; нарушение любого
  из трёх ловится существующими архитектурными тестами `layers.test.ts` и `architecture-rules.test.ts`.
- **Given** инструмент, реализованный в `presentation/mcp/tools/**` **When** его нет в
  `docs/api/mcp-tools.yaml` **Then** сборка падает; **и наоборот** — запись без реализации тоже.
- **Given** запись манифеста **When** объявленного в ней права нет в `permissions.catalog.ts`
  **Then** сборка падает с указанием ключа.
- **Given** инструмент, принимающий идентификатор ресурса **When** в манифесте не назван use-case,
  где проверяется ACL **Then** сборка падает (аналог `aclCheckedIn` из `ROUTE_REGISTRY`).
- **Given** контрактный тест HTTP **When** он проверяет соответствие роутов и спеки **Then** `/mcp`
  находится в allow-list рядом с `/health`, `/ready`, `/metrics`, `/socket.io` — с обоснованием в
  коде, а не молча.
- **Given** запрос к `/mcp` **When** он обрабатывается **Then** он проходит те же middleware
  контекста и `requestId`, что HTTP-запросы, и попадает в те же логи с тем же сквозным контекстом.

## Задачи

- [ ] Написать первым гейт манифеста: `packages/server/test/contract/mcp-tools.test.ts` — обе
      стороны соответствия, существование права, наличие `aclCheckedIn` у ресурсных инструментов.
- [ ] Завести `docs/api/mcp-tools.yaml` — форма записи: имя, описание, JSON-схема аргументов, схема
      ответа, право, идемпотентность, `destructive`, `aclCheckedIn`.
- [ ] Реализовать `presentation/mcp/mcp-server.factory.ts` поверх официального SDK: Streamable HTTP,
      монтирование только при `MCP_ENABLED=true`.
- [ ] Расширить env-схему сервера (`MCP_ENABLED`, `MCP_PUBLIC_URL`), обновить `.env.example` и
      `docs/runbooks/upgrade.md` — новая переменная в обоих местах (правило `selfhost-upgrade-checker`).
- [ ] Расширить архитектурный тест на запрет импорта `vault` из `application/ai/**` — на
      `presentation/mcp/**`.
- [ ] Добавить `/mcp` в allow-list контрактного теста с комментарием, объясняющим почему.
- [ ] Каркас одного тривиального инструмента (`system.ping`, без прав и без данных) — чтобы гейты и
      транспорт проверялись до появления доменных инструментов; удаляется в STORY-048-04.

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, production-readiness, commit-hygiene)
- [ ] Документация обновлена (`docs/api/mcp-tools.yaml`, `.env.example`, runbook) + запись в `docs/brain/`
- [ ] i18n: строк интерфейса не добавляется; сообщения об ошибках — коды, а не текст

## Ссылки

- [ADR-0024](../../../docs/architecture/adr/0024-mcp-server.md) · [`overview.md` → (и) MCP](../../../docs/architecture/overview.md)
- Правила: `rules/api-contract.mdc`, `rules/hexagonal-backend.mdc`, `rules/self-host-packaging.mdc`
