---
id: STORY-017-01
epic: EPIC-017
status: backlog
blocked: false
priority: must
estimate: M
---

# STORY-017-01 — docker-compose.prod.yml с профилями full и minimal

**Как** владелец инсталляции (P1) **я хочу** одной командой поднять весь стек — или его облегчённый
вариант на маленькой машине, — **чтобы** запуск продукта не требовал изучать шесть сервисов и их
взаимные зависимости.

## Acceptance (Given/When/Then)

1. **Профиль `full`.**
   Given чистый хост с Docker 24+ и Compose v2;
   When выполняется `docker compose -f docker-compose.prod.yml --profile full up -d`;
   Then поднимаются app, PostgreSQL 16 (pgvector), Redis 7, MinIO, Meilisearch 1.x и reverse-proxy
   (Caddy); `/healthz` отвечает, вход в систему доступен.

2. **Профиль `minimal`.**
   Given хост с 2 vCPU / 2 GB;
   When используется `--profile minimal`;
   Then Meilisearch не поднимается; приложение стартует с `SEARCH_DRIVER=postgres` и работает:
   поиск деградирует до Postgres FTS, ни один основной сценарий не отказывает (проверяется smoke-
   тестом); отсутствие Meilisearch не приводит к ошибкам в логах на каждый запрос.

3. **Инфраструктура не публикует порты.**
   Given поставляемый compose;
   When он поднят;
   Then Postgres (5432), Redis (6379), MinIO (9000/9001) и Meilisearch (7700) доступны **только**
   внутри сети compose; наружу смотрит один reverse-proxy (80/443). Проверяется тестом
   `no-published-infra-ports.spec.ts`, разбирающим compose-файл, и сканом портов в smoke-тесте
   (`T-SH-02`).

4. **Отладочный оверлей отдельно.**
   Given разработчику нужен прямой доступ к БД;
   When он использует `docker-compose.debug.yml` как оверлей;
   Then порты публикуются, и в шапке файла явно написано, что он **не для продакшена**.

5. **Версии зафиксированы.**
   Given образы сервисов;
   When проверяется compose;
   Then каждый образ указан с конкретным тегом (не `latest`) и, для инфраструктуры, с digest;
   обновление версии — отдельный PR, проходящий гейт зависимостей.

6. **Тома и данные.**
   Given перезапуск стека;
   When выполняется `down` и `up` (без `-v`);
   Then данные сохраняются: именованные тома `pgdata`, `minio-data`, `meili-data`, `caddy-data`;
   их имена и назначение описаны в runbook (важно для бэкапа).

7. **Здоровье и порядок запуска.**
   Given зависимость приложения от БД и Redis;
   When стек стартует;
   Then у инфраструктурных сервисов есть `healthcheck`, а у приложения — `depends_on: condition:
   service_healthy`; приложение не падает в рестарт-луп из-за того, что БД ещё не готова.

8. **Негативный сценарий — нехватка ресурсов.**
   Given хост с 1 GB RAM;
   When поднимается профиль `full`;
   Then документация явно указывает минимальные требования по профилям, а preflight предупреждает о
   нехватке памяти понятным сообщением (не OOM-килл посреди работы).

9. **TLS из коробки.**
   Given `APP_URL=https://crm.example.com` и открытые 80/443;
   When стек поднят;
   Then Caddy получает сертификат Let's Encrypt автоматически; HSTS включается при https;
   поставляемый `Caddyfile` содержит заголовки безопасности и обрезку query в access-логах для
   `/s3` (`T-SH-03`, `T-FILE-02`).

10. **Graceful shutdown.**
    Given `docker compose stop`;
    When приложение получает SIGTERM;
    Then in-flight запросы завершаются до 30 с, соединения закрываются, контейнер выходит с кодом 0
    (NFR-4).

11. **Один инстанс, но stateless.**
    Given целевая конфигурация 1.0;
    When проверяется приложение;
    Then оно не хранит состояния на диске контейнера (всё в Postgres, Redis, S3), и запуск второго
    инстанса не требует изменений кода (Redis-adapter для Socket.IO подключён изначально).

## Задачи

- [ ] `docker-compose.prod.yml` — сервисы с профилями `full` / `minimal`, healthchecks,
      именованные тома, внутренняя сеть, фиксированные теги и digest'ы.
- [ ] `docker-compose.debug.yml` — оверлей с публикацией портов и предупреждением.
- [ ] `deploy/caddy/Caddyfile` — TLS, HSTS, security-заголовки, `/s3`-проксирование с обрезкой query.
- [ ] `packages/server/Dockerfile` — multi-stage сборка, non-root пользователь, `HEALTHCHECK`,
      корректная обработка SIGTERM (`tini`/`--init`).
- [ ] `packages/server/src/main.ts` — graceful shutdown (30 с), готовность к `SEARCH_DRIVER=postgres`.
- [ ] `packages/server/src/infrastructure/search/postgres-fts.adapter.ts` — деградированный поиск
      для профиля `minimal` (тот же контракт `SearchPort`, включая фильтрацию по принципалам).
- [ ] `packages/e2e/tests/deploy/no-published-infra-ports.spec.ts` — разбор compose (п. 3).
- [ ] `docs/runbooks/install.md` — раздел «Профили и требования к ресурсам», список томов.

## Ссылки

- [`stack.md`, «Требования к среде» (профили и ресурсы), «Обзор стека» (версии)](../../../docs/architecture/stack.md)
- [`overview.md`, «Развёртывание»](../../../docs/architecture/overview.md)
- [`threat-model.md`, `T-SH-02`, `T-SH-03`, `T-FILE-04`, чек-лист установки п. 2–3](../../../docs/security/threat-model.md)
- [`prd.md`, NFR-3, NFR-4, риск `R-14`](../../../docs/product/prd.md)

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
