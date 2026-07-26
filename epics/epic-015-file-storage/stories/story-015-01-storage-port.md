---
id: STORY-015-01
epic: EPIC-015
status: backlog
blocked: false
priority: must
estimate: M
---

# STORY-015-01 — FileStoragePort и адаптер S3/MinIO

**Как** владелец инсталляции (P1) **я хочу** файловое хранилище, которое одинаково работает на
локальном MinIO и на любом S3-совместимом сервисе и **отказывается стартовать при небезопасной
конфигурации**, **чтобы** типовая ошибка self-host — публичный бакет — не превратилась в полный
доступ к телам всех файлов компании.

## Acceptance (Given/When/Then)

1. **Порт скрывает вендора.**
   Given `application/file/ports/file-storage.port.ts`;
   When он используется use-case'ами;
   Then интерфейс содержит `presignPut`, `presignGet`, `headObject`, `deleteObject`, `copyObject`,
   `listOrphans`; ни один use-case не импортирует `@aws-sdk/*` — проверяется архитектурным тестом.

2. **Ключ формирует сервер.**
   Given любая операция записи;
   When строится `storageKey`;
   Then он всегда имеет вид `org/{organizationId}/{scope}/{yyyy}/{mm}/{uuid}{ext}`; функция
   построения — единственная (`build-storage-key.util.ts`), клиентские значения в неё не попадают
   (митигация `T-FILE-01`).

3. **Бакет приватен.**
   Given инициализация хранилища при старте (`ensure-bucket.ts`);
   When бакет создаётся или уже существует;
   Then анонимная policy снимается явно, листинг запрещён, версионирование на стороне S3 не
   требуется (версии ведёт приложение); операция идемпотентна.

4. **Негативный сценарий — публичный бакет.**
   Given бакет допускает анонимный `GET` или листинг;
   When приложение стартует;
   Then preflight **отказывает старту** с внятным сообщением и ссылкой на пункт 4 чек-листа
   безопасной установки; предупреждения в лог недостаточно (`T-FILE-04`, топ-15).

5. **Негативный сценарий — анонимный доступ к объекту.**
   Given известный `storageKey`;
   When выполняется анонимный `GET` напрямую в MinIO;
   Then 403 — проверяется интеграционным тестом на поднятом MinIO (Testcontainers).

6. **Негативный сценарий — дефолтные креды.**
   Given `S3_ACCESS_KEY`/`S3_SECRET_KEY` равны значениям из `.env.example`
   (`CHANGE_ME_…`, `minioadmin`);
   When приложение стартует;
   Then отказ старта (`T-SH-01`), сообщение называет конкретную переменную.

7. **Порты не публикуются наружу.**
   Given поставляемый `docker-compose.prod.yml`;
   When он поднимается;
   Then MinIO не публикует порт на хост (только внутренняя сеть); preflight проверяет доступность
   9000 с внешнего интерфейса и предупреждает (`T-SH-02`, стыковка с
   [EPIC-017](../../epic-017-self-host-alpha/epic.md)).

8. **Подписи не попадают в логи.**
   Given выданная presigned-ссылка;
   When она логируется приложением или прокси;
   Then query-параметры подписи маскируются (`X-Amz-Signature`, `X-Amz-Credential`); grep-тест по
   логам e2e-прогона не находит подписи (`T-FILE-02`).

9. **Отказ хранилища не роняет приложение.**
   Given MinIO недоступен;
   When пользователь запрашивает ссылку;
   Then 503 с понятным сообщением и `Retry-After`, метрика `file_storage_error_total` растёт,
   остальные разделы продукта продолжают работать.

10. **Совместимость.**
    Given конфигурация с внешним S3 (`S3_ENDPOINT`, `S3_REGION`, `S3_FORCE_PATH_STYLE`);
    When она валидируется Zod-схемой env при старте;
    Then неверная комбинация приводит к падению с внятным сообщением, а не к работе «наполовину»
    (NFR-3).

## Задачи

- [ ] `packages/server/src/application/file/ports/file-storage.port.ts`,
      `ports/antivirus.port.ts` (объявлен, реализация опциональна — `T-FILE-05`).
- [ ] `packages/server/src/infrastructure/storage/s3-file-storage.adapter.ts` —
      `@aws-sdk/client-s3` + `s3-request-presigner`.
- [ ] `packages/server/src/infrastructure/storage/build-storage-key.util.ts` (единственный
      конструктор ключа) + `ensure-bucket.ts`.
- [ ] `packages/server/src/infrastructure/storage/storage-preflight.ts` — проверки публичности
      бакета, листинга, дефолтных кредов; вызов из `main.ts` до подъёма HTTP.
- [ ] `packages/shared/src/config/storage-env.schema.ts` — Zod-схема переменных окружения.
- [ ] `packages/server/src/infrastructure/logging/redact.config.ts` — маскирование параметров
      подписи в pino.
- [ ] Тесты: `build-storage-key.util.spec.ts`, `s3-file-storage.adapter.spec.ts` (Testcontainers
      MinIO), `storage-preflight.spec.ts` (п. 4, 6), `anonymous-get-forbidden.spec.ts` (п. 5),
      `no-aws-sdk-outside-infrastructure.spec.ts` (п. 1), grep-тест логов (п. 8).

## Ссылки

- [`overview.md`, «(г) Файловый путь», ADR-0015](../../../docs/architecture/overview.md)
- [`threat-model.md`, `T-FILE-01`, `T-FILE-02`, `T-FILE-04`, `T-SH-01`, `T-SH-02`,
  чек-лист безопасной установки п. 3–4](../../../docs/security/threat-model.md)
- [`stack.md`, `@aws-sdk/client-s3`, «Конфигурация и env»](../../../docs/architecture/stack.md)
- [`data-model.md`, группа 6, `File.storageKey`](../../../docs/architecture/data-model.md)
- PRD: NFR-3, NFR-6

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
