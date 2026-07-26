---
id: STORY-015-03
epic: EPIC-015
status: backlog
blocked: false
priority: must
estimate: L
---

# STORY-015-03 — Скачивание с проверкой прав

**Как** администратор системы (P5) **я хочу**, чтобы ссылка на скачивание выдавалась только после
проверки прав в момент запроса и жила считанные минуты, **чтобы** пересланная наружу ссылка
переставала работать почти сразу, а каждая выдача оставляла след в журнале.

## Acceptance (Given/When/Then)

1. **Проверка прав до выдачи ссылки.**
   Given пользователь с `file:download` и уровнем ≥ `VIEWER` на файле (по цепочке
   `File → FileFolder → Project → Organization`);
   When `GET /api/v1/files/{fileId}/download-url`;
   Then сервер выполняет `can()` **в момент запроса**, затем выдаёт presigned GET с
   `expiresIn = 300` (TTL ≤ 300 c при потолке NFR-6 в 15 минут) и возвращает `{ url, expiresAt }`.

2. **Подпись привязана к методу и отдаче.**
   Given выданная ссылка;
   When она проверяется;
   Then подпись включает метод **GET**, точный ключ,
   `response-content-disposition=attachment; filename="…"` и `response-content-type`, приведённый к
   безопасному значению; попытка использовать ссылку для PUT/DELETE отклоняется хранилищем.

3. **Негативный сценарий — нет прав.**
   Given пользователь без `file:download` → 403 `permission_not_granted`;
   Given пользователь с capability, но уровнем `NONE` на цепочке → **404** `resource_not_found`;
   Given файл другой организации → **404**;
   When запрашивается ссылка;
   Then ни в одном из случаев presigned-ссылка не выдаётся и не логируется как выданная.

4. **Негативный сценарий — файл в карантине или не проверен.**
   Given `scanStatus = PENDING` или `INFECTED`;
   When запрашивается ссылка;
   Then 409 `file_not_available`; скачивание карантинного файла возможно только с правами
   `file:view_quarantined` + `file:download_quarantined` (оба `dangerous`) и всегда пишется в
   `AuditLog` (`T-FILE-05`).

5. **Негативный сценарий — HTML и SVG.**
   Given файл с `mimeType ∈ {text/html, image/svg+xml}`;
   When он отдаётся;
   Then только как `attachment` с `X-Content-Type-Options: nosniff`; inline-рендер невозможен;
   e2e с SVG-payload подтверждает, что скрипт не исполняется в контексте приложения (`T-FILE-06`).

6. **Чувствительные файлы — через прокси.**
   Given файл помечен как «чувствительный» (например, `scope = VAULT` или явный флаг);
   When запрашивается скачивание;
   Then вместо presigned-ссылки отдаётся поток через API (`GET /files/{id}/content`) с проверкой
   прав на каждый запрос; отзыв доступа немедленно прекращает скачивание (компенсация `RR-05`).

7. **Аудит каждой выдачи.**
   Given успешная выдача;
   When она произошла;
   Then в `AuditLog` — `file.download_url_issued` с `fileId`, актором, `ipHash`, `requestId` и
   `expiresAt`; **сама ссылка и подпись в журнал не попадают**.

8. **Ссылка не утекает в логи и реферер.**
   Given страница просмотра файла;
   When пользователь переходит по ссылке;
   Then заголовок `Referrer-Policy: no-referrer` установлен, подпись маскируется в логах приложения
   и в поставляемом конфиге reverse-proxy (обрезка query для `/s3`); grep-тест e2e-логов не находит
   `X-Amz-Signature` (`T-FILE-02`).

9. **Ссылка не кешируется клиентом дольше TTL.**
   Given ответ с `url`;
   When он кешируется TanStack Query;
   Then `staleTime` короче TTL, `gcTime` не превышает TTL; повторный запрос после истечения
   выполняет новую проверку прав, а не переиспользует старую ссылку.

10. **Негативный сценарий — потеря доступа.**
    Given ссылка выдана, затем пользователь удалён из проекта;
    When он запрашивает **новую** ссылку;
    Then 404. Ранее выданная ссылка продолжает работать до истечения TTL — это свойство механизма,
    зафиксированное как остаточный риск `RR-05`; митигация — короткий TTL и проксирование
    чувствительных файлов.

11. **Производительность.**
    Given список из 100 файлов;
    When он отрисовывается;
    Then ссылки **не** выдаются пачкой заранее: URL запрашивается по действию пользователя;
    список отдаёт только метаданные и признаки `permissions.canDownload`.

## Задачи

- [ ] `packages/server/src/application/file/use-cases/issue-download-url.use-case.ts`,
      `stream-file-content.use-case.ts` (проксирование).
- [ ] `packages/server/src/domain/file/access/file-access.policy.ts` — `canDownload`,
      `canDownloadQuarantined`, `assertScanned`.
- [ ] `packages/server/src/presentation/http/controllers/file.controller.ts` — заголовки
      `nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: private, no-store`.
- [ ] `packages/server/src/presentation/http/routes/registry.ts` — `file:download`,
      `file:view_quarantined`, `file:download_quarantined` c `aclCheckedIn`.
- [ ] `packages/server/src/infrastructure/logging/redact.config.ts` — маскирование query-подписи.
- [ ] `deploy/caddy/Caddyfile` — обрезка query в access-логах для `/s3` (поставляемый конфиг,
      стыковка с [EPIC-017](../../epic-017-self-host-alpha/epic.md)).
- [ ] `packages/client/src/units/file/service/hooks/use-file-download.hook.ts` (запрос по действию,
      короткий `gcTime`), `shared/ui/file-download-button.component.tsx`.
- [ ] Тесты: `issue-download-url.use-case.spec.ts` (п. 1, 3, 4), `presigned-ttl-and-method.spec.ts`
      (п. 2), `html-svg-attachment-only.spec.ts` + e2e SVG-payload (п. 5),
      `download-audit.spec.ts` (п. 7), grep-тест логов (п. 8).

## Ссылки

- [`threat-model.md`, «Файлы и presigned URL» (таблица свойств), `T-FILE-02`, `T-FILE-05`,
  `T-FILE-06`, остаточный риск `RR-05`](../../../docs/security/threat-model.md)
- [`permission-model.md` §3.8 (`file:download` — `VIEWER`; квази-опасные права карантина)](../../../docs/security/permission-model.md)
- [`overview.md`, «(г) Файловый путь», доступ на чтение](../../../docs/architecture/overview.md)
- [`prd.md`, NFR-6 (presigned ≤ 15 минут), риск `R-12`](../../../docs/product/prd.md)

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
