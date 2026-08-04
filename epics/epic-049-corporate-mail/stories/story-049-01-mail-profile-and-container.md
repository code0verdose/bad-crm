---
id: STORY-049-01
epic: EPIC-049
status: backlog
blocked: false
priority: must
estimate: M
---

# STORY-049-01 — Профиль `mail` и контейнер Stalwart

**Как** владелец инсталляции **я хочу** включать почтовый сервер одним профилем **чтобы** установка
без корпоративной почты не платила за неё ни ресурсами, ни открытыми портами.

## Acceptance (Given/When/Then)

- **Given** установка без профиля `mail` **When** выполняю `pnpm docker:up` **Then** контейнера Stalwart нет, порты 25/465/587/143/993 не слушаются, интерфейс почты в приложении скрыт целиком.
- **Given** профиль `mail` **When** он включён **Then** Stalwart поднимается со своим томом, его состояние видно в `/ready` как **опциональная** зависимость (`disabled`, когда профиль выключен) и не влияет на HTTP-статус готовности.
- **Given** обновление инсталляции **When** появляется новая переменная окружения профиля **Then** она есть и в `.env.example`, и в `docs/runbooks/upgrade.md` (правило `selfhost-upgrade-checker`).
- **Given** том с письмами **When** смотрю процедуру бэкапа **Then** он в ней описан: `pg_dump` его не покрывает.
- **Given** образ Stalwart **When** он закрепляется **Then** он пинуется по digest, а не по плавающему тегу, и обновляется через dependabot-джобу docker-compose.

## Задачи

- [ ] Тесты первыми: `test/infra/compose.test.ts` — сервис только под профилем, порты не публикуются без него, digest вместо тега; проба готовности как опциональная.
- [ ] Сервис в `docker-compose.yml` под профилем `mail`, том, healthcheck.
- [ ] Переменные окружения профиля в схеме, `.env.example` и runbook обновления.
- [ ] Раздел в `docs/runbooks/backup-restore.md` про том писем.

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят
- [ ] Commit-гейт зелёный; `selfhost-upgrade-checker`
- [ ] Документация обновлена (`docs/runbooks/`) + запись в `docs/brain/`

## Ссылки

- [ADR-0025 → §1](../../../docs/architecture/adr/0025-corporate-mail-stalwart.md) · Правила: `rules/self-host-packaging.mdc`
