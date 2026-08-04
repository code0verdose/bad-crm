---
id: STORY-049-02
epic: EPIC-049
status: backlog
blocked: false
priority: must
estimate: L
---

# STORY-049-02 — Каталог: наш PostgreSQL как источник учётных записей

**Как** администратор организации **я хочу**, чтобы почтовый сервер спрашивал учётные записи у Bad CRM
**чтобы** сотрудник заводился один раз и жил с одним паролем.

## Acceptance (Given/When/Then)

- **Given** Stalwart с SQL-каталогом **When** сотрудник входит в почтовый клиент паролем от CRM **Then** вход проходит — проверено интеграционным тестом с **настоящим** Stalwart в контейнере, а не моком.
- **Given** роль `app_mail` **When** проверяю её права **Then** у неё нет прав ни на одну таблицу; доступен только вызов трёх `SECURITY DEFINER`-функций (`mail_lookup_account`, `mail_lookup_aliases`, `mail_lookup_domain`).
- **Given** функции каталога **When** смотрю, что они возвращают **Then** адрес, хеш пароля, квоту, статус и алиасы — и ничего сверх; `search_path` пинован, владелец — отдельная роль без права подключения (образец `auth_lookup_*` из EPIC-006).
- **Given** сотрудник со статусом `SUSPENDED` или `deletedAt` **When** он пытается войти в почту **Then** отказ **на этой же аутентификации**, без джоба и без ожидания.
- **Given** смена пароля в CRM **When** она произошла **Then** почтовый клиент требует новый пароль — потому что хеш один и тот же.
- **Given** пользователь без `MailAccount` **When** он пытается войти в почту **Then** отказ: наличие учётной записи CRM само по себе ящика не даёт.

## Задачи

- [ ] Тесты первыми: интеграционный с контейнером Stalwart (вход паролем из нашей БД, отказ приостановленному, отказ без ящика); структурный тест прав роли `app_mail`.
- [ ] Миграция: роль, функции, гранты по образцу `20260729120000_auth_owner_and_lookup_functions`.
- [ ] Конфигурация SQL-каталога Stalwart, вынесенная в файл под контролем версий.
- [ ] Проверка формата хеша: PHC-строка argon2id из `@node-rs/argon2` принимается как есть (тест на реальном хеше).

## Definition of Done

- [ ] Тесты написаны первыми (TDD), включая isolation- и структурные
- [ ] Commit-гейт зелёный; `db-reviewer`, `tenancy-rls-auditor`, `security-auditor`
- [ ] Запись в `docs/brain/`

## Ссылки

- [ADR-0025 → §2, §3](../../../docs/architecture/adr/0025-corporate-mail-stalwart.md) · [`rls-design.md`](../../../docs/security/rls-design.md)
- Правила: `rules/tenancy-rls.mdc`, `rules/db-migrations.mdc`, `rules/security.mdc`
