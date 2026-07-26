---
id: STORY-017-03
epic: EPIC-017
status: backlog
blocked: false
priority: must
estimate: M
---

# STORY-017-03 — `.env.example` и генерация секретов

**Как** владелец инсталляции (P1) **я хочу** получить понятный пример конфигурации и скрипт,
который сгенерирует все секреты за меня, **чтобы** не выбирать между «придумаю пароли сам» и
«оставлю как в примере» — и не превратить инсталляцию в открытую дверь.

## Acceptance (Given/When/Then)

1. **Пример разделён на обязательное и опциональное.**
   Given `.env.example`;
   When владелец его открывает;
   Then он разбит на секции: **обязательные** (`APP_URL`, `DATABASE_URL`,
   `DATABASE_MIGRATION_URL`, `DATABASE_AUTH_URL`, `JWT_SECRET`, `APP_ENCRYPTION_KEY`, креды
   Postgres/MinIO), **опциональные** (`SMTP_*`, `MEILI_MASTER_KEY`, AI-провайдеры, `GITHUB_*`) и
   **режимные** (`NODE_ENV`, `SIGNUP_MODE`, `SEARCH_DRIVER`); у каждой переменной — комментарий с
   назначением, форматом и последствием отсутствия.

2. **Только плейсхолдеры.**
   Given значения в примере;
   When они проверяются;
   Then каждое секретное значение — `CHANGE_ME_…`; ни одного «рабочего» дефолта вроде
   `minioadmin`, `postgres`, `changeme123`; тест `env-example-has-no-real-secrets.spec.ts` это
   подтверждает (`T-SH-01`).

3. **Генерация секретов скриптом.**
   Given чистая машина;
   When выполняется `./scripts/bootstrap-secrets.sh`;
   Then создаётся `.env` из примера, все `CHANGE_ME_…` заменяются CSPRNG-значениями (`openssl rand`),
   `APP_ENCRYPTION_KEY` — ровно 32 байта в base64, `JWT_SECRET` ≥ 32 байт; файл создаётся с правами
   `600`; существующий `.env` **не перезаписывается** без явного `--force`.

4. **Валидация той же схемой, что и рантайм.**
   Given `packages/shared/src/config/env.schema.ts`;
   When приложение стартует;
   Then `envSchema.parse(process.env)` выполняется один раз в composition root; неверная
   конфигурация приводит к падению с перечнем конкретных переменных и ожидаемых форматов, а не к
   работе «наполовину» (NFR-3).

5. **Негативный сценарий — примерное значение осталось.**
   Given `JWT_SECRET=CHANGE_ME_generate_with_openssl`;
   When приложение стартует;
   Then отказ старта с сообщением, называющим переменную и команду генерации (`T-SH-01`,
   `T-IAM-05`).

6. **Негативный сценарий — неверный `APP_ENCRYPTION_KEY`.**
   Given ключ длиной 16 байт или не в base64;
   When приложение стартует;
   Then отказ: Zod требует ровно 32 байта base64; сообщение объясняет, чем этот ключ шифрует
   (`totpSecretEnc`, `emergencyContactEnc`, токены интеграций) и почему его нельзя потерять
   (`T-SH-04`).

7. **Ротация ключа шифрования описана.**
   Given необходимость сменить `APP_ENCRYPTION_KEY`;
   When владелец читает runbook;
   Then описана процедура с версионированием префикса (`v1:` → `v2:`), фоновой перешифровкой и
   правилом «старый ключ хранится до завершения перешифровки»; поддержка двух ключей
   (`APP_ENCRYPTION_KEY` + `APP_ENCRYPTION_KEY_PREVIOUS`) реализована в адаптере.

8. **Секреты не попадают в логи и в клиентский бандл.**
   Given старт и сборка;
   When гоняются тесты;
   Then `pino.redact` маскирует значения по фиксированному списку путей; grep-тест по клиентской
   сборке не находит `MEILI_MASTER_KEY`, `JWT_SECRET`, `APP_ENCRYPTION_KEY` и кредов S3
   (`T-PLAT-03`, `T-PLAT-06`).

9. **Дефолты закрытой инсталляции.**
   Given `.env.example`;
   When проверяются значения по умолчанию;
   Then `SIGNUP_MODE=invite_only` (закрытая регистрация), `AI_ENABLED=false`,
   `TELEMETRY=false`, `UPDATE_CHECK=false` — по NFR-9 и `T-TENANT-07`.

10. **Работа без опциональных сервисов.**
    Given не заданы `SMTP_*`, `MEILI_MASTER_KEY` и AI-ключи;
    When приложение стартует;
    Then оно работает: приглашения выдаются ссылкой, поиск деградирует на Postgres FTS, AI выключен;
    в лог пишется **одна** информационная строка на каждый отключённый компонент, а не поток
    предупреждений.

11. **Учёт увиденных секретов.**
    Given разработчик или агент видит реальный секрет в процессе работы;
    When это происходит;
    Then действует правило учёта утечек: фиксация (маскированно) вне репозитория и предупреждение
    о необходимости ротации; сам `.env` в git не попадает (`.gitignore` + `scan-secrets` в гейте).

## Задачи

- [ ] `.env.example` — секции, комментарии, плейсхолдеры `CHANGE_ME_…`.
- [ ] `scripts/bootstrap-secrets.sh` — CSPRNG-генерация, права `600`, защита от перезаписи,
      поддержка `--force` и `--print` (вывод без записи).
- [ ] `packages/shared/src/config/env.schema.ts` — Zod-схема (обязательные/опциональные,
      `z.coerce`, проверка base64-длины ключа, запрет `http://` вне `development`).
- [ ] `packages/server/src/main.ts` — единственная точка `envSchema.parse`, типобезопасный `env`.
- [ ] `packages/server/src/infrastructure/crypto/field-encryption.adapter.ts` — префикс версии
      ключа, поддержка `APP_ENCRYPTION_KEY_PREVIOUS`.
- [ ] `packages/server/src/infrastructure/logging/redact.config.ts` — список маскируемых путей.
- [ ] `docs/runbooks/install.md` — таблица переменных; `docs/runbooks/key-rotation.md` — ротация
      `APP_ENCRYPTION_KEY`.
- [ ] Тесты: `env.schema.spec.ts` (п. 4–6, 9), `env-example-has-no-real-secrets.spec.ts` (п. 2),
      `bootstrap-secrets.spec.ts` (п. 3), grep-тест клиентской сборки (п. 8),
      интеграционный «старт без опциональных сервисов» (п. 10).

## Ссылки

- [`threat-model.md`, «Self-host специфика» (`T-SH-01`, `T-SH-04`), `T-IAM-05`, `T-PLAT-03`,
  `T-PLAT-06`, `T-TENANT-07`, чек-лист установки п. 1, 6, 9](../../../docs/security/threat-model.md)
- [`stack.md`, «Конфигурация и env»](../../../docs/architecture/stack.md)
- [`prd.md`, NFR-3, NFR-9](../../../docs/product/prd.md)
- [`rls-design.md`, «`DATABASE_URL` для каждой роли»](../../../docs/security/rls-design.md)

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
