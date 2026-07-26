---
id: STORY-017-05
epic: EPIC-017
status: backlog
blocked: false
priority: must
estimate: M
---

# STORY-017-05 — Bootstrap первого владельца

**Как** владелец инсталляции (P1) **я хочу**, чтобы после первого запуска у меня сразу была
организация и учётная запись владельца, **чтобы** не гадать, кто и как создаёт первого
пользователя, и чтобы это окно не осталось открытым для чужого.

## Acceptance (Given/When/Then)

1. **Неинтерактивный путь.**
   Given заданы `BOOTSTRAP_ORG_NAME`, `BOOTSTRAP_ORG_SLUG`, `BOOTSTRAP_OWNER_EMAIL` и
   `BOOTSTRAP_OWNER_PASSWORD` (или `BOOTSTRAP_OWNER_PASSWORD_FILE`);
   When приложение стартует на пустой БД;
   Then в одной транзакции создаются `Organization`, системные роли, `User(status = ACTIVE)` с
   ролью `owner`, `Organization.ownerId`; в `AuditLog` — `organization.created` и `role.assigned`
   с `actorType = SYSTEM`.

2. **Интерактивный путь.**
   Given переменные bootstrap не заданы и БД пуста;
   When владелец открывает `APP_URL`;
   Then он попадает на **одноразовый** экран первичной настройки (`/setup`): организация, e-mail,
   пароль, язык, часовой пояс; после успешного создания экран становится недоступен навсегда.

3. **Ровно один раз.**
   Given организация уже создана;
   When приложение перезапускается с теми же `BOOTSTRAP_*` или кто-то открывает `/setup`;
   Then второй владелец **не** создаётся, пароль существующего **не** сбрасывается; `/setup`
   отвечает 404; в лог пишется одна информационная строка.

4. **Негативный сценарий — гонка на `/setup`.**
   Given два параллельных запроса на создание первой организации;
   When они выполняются;
   Then успешен ровно один: используется advisory-lock либо уникальное ограничение «одна
   инсталляция — один bootstrap»; второй получает 409 (конкурентный тест).

5. **Негативный сценарий — слабый пароль.**
   Given `BOOTSTRAP_OWNER_PASSWORD` не проходит политику паролей;
   When приложение стартует;
   Then старт отклоняется с внятным сообщением (лучше отказ, чем владелец с паролем `admin123`);
   на интерактивном пути — inline-ошибка поля.

6. **Негативный сценарий — пароль в переменных окружения.**
   Given `BOOTSTRAP_OWNER_PASSWORD` задан;
   When он использован;
   Then значение **не** логируется, маскируется в отладочных дампах env и очищается из
   `process.env` сразу после использования; поддерживается `*_FILE`-вариант (docker secret) как
   рекомендуемый; документация прямо советует сменить пароль после первого входа.

7. **Закрытая регистрация по умолчанию.**
   Given `SIGNUP_MODE=invite_only` (дефолт);
   When кто-то пытается зарегистрировать вторую организацию через публичный эндпоинт;
   Then 403 — дальнейшие пользователи появляются только по приглашению
   ([EPIC-012](../../epic-012-employee-management/epic.md)); открытая регистрация включается явно и
   помечается preflight'ом как `WARN` (`T-TENANT-06`, `T-TENANT-07`).

8. **Требование 2FA сразу после старта.**
   Given чек-лист безопасной установки (п. 7);
   When владелец впервые входит;
   Then экран приветствия предлагает включить TOTP и обязательную 2FA для роли `owner`
   ([EPIC-013](../../epic-013-two-factor-totp/epic.md)); отказ фиксируется и повторяется как баннер.

9. **Кросс-проверка целостности.**
   Given созданная инсталляция;
   When проверяется состояние;
   Then организация имеет ровно одного активного владельца, все 7 системных ролей и полный
   справочник `Permission` — инвариант проверяется smoke-тестом чистой установки.

10. **Негативный сценарий — bootstrap на непустой БД.**
    Given БД содержит организации;
    When заданы `BOOTSTRAP_*`;
    Then они игнорируются с информационной записью в лог; попытка «переинициализации» невозможна.

11. **a11y и i18n экрана `/setup`.**
    Given одноразовый экран настройки;
    When он проверяется axe и с клавиатуры;
    Then 0 нарушений A/AA, выбор языка доступен сразу (EN/RU), все строки — из i18n, ошибки формы
    inline.

## Задачи

- [ ] `packages/server/src/application/organization/use-cases/bootstrap-installation.use-case.ts` —
      одна транзакция: организация + системные роли + владелец + `ownerId`.
- [ ] `packages/server/src/infrastructure/bootstrap/bootstrap-runner.ts` — вызов из entrypoint,
      advisory-lock, проверка пустоты БД, очистка пароля из `process.env`.
- [ ] `packages/shared/src/config/bootstrap-env.schema.ts` — Zod-схема `BOOTSTRAP_*`
      (включая `*_FILE`-варианты и политику пароля).
- [ ] `packages/server/src/presentation/http/routes/registry.ts` — `POST /setup` с `public: true` и
      `publicReason` («первичная инициализация до появления пользователей»), доступен только при
      пустой инсталляции.
- [ ] `packages/client/src/app/routes/setup.tsx` + `pages/setup/page.tsx`,
      `widgets/setup-wizard/setup-wizard.widget.tsx`,
      `units/organization/model/validation/setup.schema.ts`.
- [ ] `packages/client/src/widgets/welcome-checklist/welcome-checklist.widget.tsx` — предложение
      включить 2FA и пройти чек-лист безопасности (п. 8).
- [ ] i18n: `packages/client/src/app/i18n/{en,ru}/setup.json`.
- [ ] Тесты: `bootstrap-installation.use-case.spec.ts` (п. 1, 3, 5, 10), конкурентный
      `setup-race.spec.ts` (п. 4), grep-тест логов на пароль (п. 6),
      интеграционный «`/setup` → 404 после инициализации», e2e `first-run.spec.ts` + axe.

## Ссылки

- [`threat-model.md`, чек-лист безопасной установки (п. 7, 9), `T-TENANT-06`, `T-TENANT-07`,
  `T-IAM-08`](../../../docs/security/threat-model.md)
- [`permission-model.md` §2 «Про owner» (инвариант «минимум один владелец»), §4](../../../docs/security/permission-model.md)
- [`prd.md`, NFR-3 («time-to-first-value < 15 минут»), персона P1](../../../docs/product/prd.md)
- [`rls-design.md`, «Путь 1. Логин: организация ещё не известна»](../../../docs/security/rls-design.md)
- [`ux-architecture.md`, «Публичная зона», «Формы»](../../../docs/architecture/ux-architecture.md)

## Definition of Done

- [ ] Тесты написаны первыми (TDD), проходят, изменённый код покрыт
- [ ] Commit-гейт зелёный (test-coverage, security-auditor, db-reviewer при изменении схемы, production-readiness, commit-hygiene)
- [ ] Документация обновлена (docs/ + запись в `docs/brain/`)
- [ ] a11y и i18n (для UI-историй)
- [ ] **Isolation-тест RLS** для каждой новой таблицы
- [ ] **Permission объявлена** для каждого нового endpoint и проверяется в use-case
