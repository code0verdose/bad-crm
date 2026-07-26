# Bad CRM

**Self-hosted, multi-tenant workspace for software teams.** Projects, kanban tasks, block documents,
a markdown knowledge base, files, time tracking, dashboards, team chat, an end-to-end encrypted
password vault, secure links, GitHub Actions status, and an AI assistant — in one installation, with
one data model, one permission model, and one `docker compose up`.

Licensed under **AGPL-3.0-or-later**. Interface in **English and Russian**.

[Русская версия README](README.ru.md)

---

> ## ⚠️ Project status: design phase — there is no code yet
>
> This repository currently contains **specification and work breakdown only**: product and
> architecture documents, ADRs, security design, development rules, and epics with user stories.
> There is no `packages/` directory, no `docker-compose.yml`, no runnable application, no release,
> and no Docker image.
>
> Every feature described below is **planned**, not shipped. Every command in the Quick start section
> is **the intended interface**, not something you can run today. Nothing here has been built,
> benchmarked, or audited.
>
> If you are looking for software to install right now, this is not it yet. If you are interested in
> how it is being designed — or want to help build it — read on.

---

## Screenshot

<!-- Placeholder: a screenshot of the project dashboard will go here once the UI exists (M2+). -->

*No screenshots yet — nothing has been built. This section will be filled in as soon as there is a
running interface to show.*

---

## What it is

Bad CRM is a workspace for software teams of roughly 5 to 50 people. It exists because that context
is normally spread across six or seven unconnected SaaS products: the task lives in one tool, its
specification in another, the discussion in a third, the staging credentials in a fourth, and the
hours spent on it in a fifth.

The bet is not "another issue tracker". The bet is **connectedness**: project and person are the two
central models, and everything else hangs off them — tasks, documents, knowledge, files, secrets,
time, chat, pipelines, and money. One graph, one search, one permission model, one installation.

The word "CRM" here means managing the relationship with the **customer of a development project**
(contract, milestones, acceptance, invoices), not sales.

## Who it is for

| Role | What they get |
|---|---|
| **Developer** | Tasks, specifications, chat, and a timer in one place; full context on a task without switching tools |
| **Team lead** | Planning, review, workload and time reports across people and projects |
| **Project lead / PM** | Clients, contracts, budget vs. burn, milestone acceptance, calls and the decisions that came out of them |
| **Organization admin** | One place to onboard and offboard a person, one permission model to grant and revoke |
| **Installation owner** | Data on their own hardware, no per-seat pricing, the ability to fork and audit |

## What it deliberately is not

Not a sales CRM (no leads or pipelines), not a helpdesk for external customers, not an HR system
(no recruiting, reviews, or compensation), not a general-purpose BI report builder, not a plugin
marketplace. It is also not a hosted service — there is no SaaS offering and none is planned.

---

## Features

Everything in this section is **planned**. The milestone column says when it is scheduled; see the
[roadmap](#roadmap) for what each milestone means.

| Domain | What is planned | Milestone |
|---|---|---|
| **Organizations and tenancy** | Multiple organizations per installation, isolated at the database level with PostgreSQL Row Level Security | M1 |
| **Authentication** | Organization sign-up, sessions with refresh rotation and reuse detection, password recovery, TOTP two-factor | M1, M2 |
| **People and permissions** | Employee profiles, roles, per-user permission overrides, resource-level ACLs, audit log | M2 |
| **Projects** | Project cards, members, statuses, links to everything else in the system | M2 |
| **Files** | S3-compatible storage (MinIO or any S3), presigned uploads, permission-checked downloads | M2 |
| **Tasks** | Kanban boards and columns, task cards, comments, attachments, per-task access control | M3 |
| **Documents** | Notion-like block documents with versioning | M4 |
| **Knowledge base** | Obsidian-like markdown notes with backlinks and a graph view | M4 |
| **Search** | Instant, typo-tolerant, permission-aware search across all domains | M4 |
| **Chat and notifications** | Slack-like channels, rich messages, presence, real-time notifications | M5 |
| **Time tracking** | Timer and manual entries, timesheets, approval flow | M6 |
| **Dashboards** | Project, people, and money dashboards; per-employee drill-down | M6 |
| **Secrets vault** | End-to-end encrypted password vault — the server stores ciphertext only and cannot read it | M7 |
| **Secure links** | One-time and restricted links for handing a secret to someone | M7 |
| **GitHub integration** | Reading Actions, deployment, and commit status, linked to tasks | M8 |
| **AI assistant** | Chat and retrieval over your own data, on the LLM provider the admin chooses (Anthropic, OpenAI, any OpenAI-compatible endpoint, OpenRouter) | M8 |
| **Onboarding** | Onboarding materials and checklists for new team members | M8 |
| **Project leadership** | Clients, contracts, invoices, budget vs. burn, sprints and delivery, calls and calendar | M9 |

Two components are **optional by design** — the application must start and work without them, with
degraded features rather than a failure: Meilisearch (search falls back to PostgreSQL full-text) and
AI (features are hidden and return a clear "feature disabled" response).

---

## Quick start

> **Not available yet.** The self-hosted alpha ships in **EPIC-017**, at the end of milestone M2.
> Until then there is no image to pull and no compose file to run. The commands below are the
> intended interface, recorded here so the design is reviewable — they will not work today.

### Requirements (planned)

| | Minimum | Recommended |
|---|---|---|
| CPU / RAM | 2 vCPU / 2 GB (`minimal` profile) | 2 vCPU / 4 GB (`default` profile) |
| Disk | 10 GB + your data | SSD, sized for files and backups |
| Software | Docker 24+ with Compose v2 | Same, plus a reverse proxy with TLS |
| OS | Linux (x86-64 or arm64) | Same |

### Intended flow

```bash
git clone https://github.com/<org>/bad-crm.git
cd bad-crm
cp .env.example .env
# generate the mandatory encryption key
openssl rand -base64 32          # → APP_ENCRYPTION_KEY
docker compose up -d
```

Then open the application, create the first organization, and become its owner. The full procedure,
including the mandatory post-install security checklist, is in
[`docs/runbooks/install.md`](docs/runbooks/install.md).

The `minimal` profile drops Meilisearch and runs the workers inside the API process, for small
installations on constrained hardware.

---

## Configuration

Configuration is environment variables only, parsed once at startup by a schema. A configuration
error means the process refuses to start — not a 500 an hour later.

**Required:**

| Variable | What it is |
|---|---|
| `APP_URL` | Public URL of the installation; drives CORS, cookies, and links in emails |
| `DATABASE_URL` | PostgreSQL connection string for the application role (must **not** have `BYPASSRLS`) |
| `REDIS_URL` | Redis connection string |
| `JWT_SECRET` | Signing secret for short-lived access tokens, at least 32 characters |
| `APP_ENCRYPTION_KEY` | 32 bytes, base64 — encrypts integration secrets at rest. **Losing it makes stored integration credentials unrecoverable** |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | Object storage for files |

**Optional (absence degrades a feature, never breaks startup):**

| Variable | Effect when unset |
|---|---|
| `SMTP_URL` | Emails are logged instead of sent (dev) / mail operations fail with a clear error (prod) |
| `MEILI_HOST`, `MEILI_MASTER_KEY` | Search falls back to PostgreSQL full-text; a banner explains the reduced capability |
| `AI_ENABLED` | AI features are hidden in the UI and return `feature_disabled` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Traces are not exported; logs and metrics still work |
| `LOG_LEVEL` | Defaults to `info` |

**LLM provider API keys never live in environment variables.** They are entered by an organization
admin in the UI and stored encrypted in the database. `AI_ENABLED` is only an installation-wide
switch.

The complete list with comments and safe defaults will live in `.env.example` (created in EPIC-001).

---

## Architecture

```
                Browser (React 19 + Vite)
                 ─ the only place the vault is ever decrypted
                          │ HTTPS / WebSocket
                          ▼
              Reverse proxy (TLS, sticky /socket.io)
                          │
        ┌─────────────────┴──────────────────┐
        │   Application image (one image)    │
        │   ROLE=api          ROLE=worker    │
        │   Express 5, hexagonal architecture│
        └─────────────────┬──────────────────┘
                          │
   ┌──────────┬───────────┼───────────┬─────────────┐
   ▼          ▼           ▼           ▼             ▼
PostgreSQL   Redis      MinIO    Meilisearch      SMTP
16+pgvector  7          (S3)     (optional)
RLS-isolated queues,    files    search
per tenant   pub/sub
```

Key decisions, each with its own ADR:

- **Multi-tenancy through PostgreSQL Row Level Security**, not through remembering to add a `WHERE`
  clause — a second, independent line of defence below the application ([ADR-0004](docs/architecture/adr/0004-multi-tenancy-postgres-rls.md)).
- **Hexagonal backend**: domain rules and access policies are pure and testable without a database;
  infrastructure is replaceable ([ADR-0002](docs/architecture/adr/0002-hexagonal-backend-express-prisma.md)).
- **Contract-first API**: OpenAPI 3.1 is the source of truth, hand-edited in review; client types are
  generated from it and a two-way contract test fails the build on drift ([ADR-0003](docs/architecture/adr/0003-openapi-as-source-of-truth.md)).
- **Transactional outbox**: domain events are written in the same transaction as the data, then
  dispatched to queues — nothing external happens inside a transaction ([ADR-0021](docs/architecture/adr/0021-transactional-outbox.md)).
- **Zero-knowledge vault**: keys are derived and used only in the browser; the server holds
  ciphertext and metadata and cannot decrypt anything ([ADR-0009](docs/architecture/adr/0009-e2ee-vault-key-hierarchy.md)).

Full documentation: [`docs/README.md`](docs/README.md) — start there.
System overview: [`docs/architecture/overview.md`](docs/architecture/overview.md).
All 21 decision records: [`docs/architecture/adr/`](docs/architecture/adr/).

---

## Roadmap

Nine milestones from an empty repository to a self-hosted 1.0. A milestone closes only when its exit
criteria are met in full; leftovers do not get carried forward as a tail.

| Milestone | Goal | Epics | Status |
|---|---|---|---|
| **M1** | Foundation: monorepo, CI and commit gate, server skeleton and API contract, client shell, RLS tenancy, auth, design system, EN/RU, observability, e2e harness | 10 | Not started |
| **M2** | People, permissions, projects, files: RBAC, employee management, TOTP, project core, file storage, audit log, first self-hosted alpha | 7 | Not started |
| **M3** | Tasks: boards and columns, task core, collaboration, per-task access control | 4 | Not started |
| **M4** | Knowledge: block documents, knowledge base, permission-aware search | 3 | Not started |
| **M5** | Real time: realtime infrastructure, chat core, rich messaging, notifications | 4 | Not started |
| **M6** | Time and analytics: time tracking, timesheets and approval, dashboards, employee drill-down | 4 | Not started |
| **M7** | Secrets: E2EE crypto foundation, vault items, vault sharing, secure links | 4 | Not started |
| **M8** | Integrations and AI: GitHub, AI provider administration, AI assistant, onboarding materials | 4 | Not started |
| **M9** | Leadership and release: clients and contracts, billing and budget, sprints and delivery, calls and calendar, security hardening, self-hosted 1.0 | 6 | Not started |

46 epics total. Detailed milestone contents and exit criteria:
[`docs/product/roadmap.md`](docs/product/roadmap.md). Epic and story files: [`epics/`](epics/).

---

## Contributing

Contributions are welcome — the project is in the phase where design feedback is worth more than
code. Please read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a pull request. In short:

- Work happens inside an epic and a story; no code without one.
- **Test-driven development is mandatory** — the failing test comes first.
- Every commit passes the six-check commit gate and the rules in [`rules/`](rules/).
- Commits follow Conventional Commits, in English.
- We use a **DCO** (`Signed-off-by`), not a CLA.

Please also read [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## Security

Do **not** report vulnerabilities through public issues. The reporting channel, response times,
scope, and the disclosure policy are in [`SECURITY.md`](SECURITY.md).

The vault's guarantees — and, just as importantly, what it does **not** guarantee — are documented
in [`docs/security/e2ee-design.md`](docs/security/e2ee-design.md) and
[`docs/security/threat-model.md`](docs/security/threat-model.md). Both are worth reading before you
trust any product with your secrets, including this one.

## License

**GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).** Full text: [`LICENSE`](LICENSE).

What this means in practice for anyone who hosts Bad CRM:

- You may run it for any purpose, including commercially, and modify it however you like.
- If you **make a modified version available to users over a network**, AGPL section 13 requires you
  to offer those users the complete corresponding source of your modified version. Running an
  unmodified copy for your own team creates no such obligation beyond keeping the license and notices
  intact.
- Distributing the software, modified or not, carries the usual GPL-family obligations: source
  availability, license and copyright notices preserved, and the same license on the whole work.
- There is no CLA, so the project cannot be relicensed out from under contributors.

Dependencies are restricted to AGPL-compatible licenses; BSL, SSPL, Elastic License, Commons Clause,
"free for non-commercial", and GPL-2.0-only are excluded, and a license check is part of CI. See
[ADR-0018](docs/architecture/adr/0018-license-agpl-3.md).

This is a summary, not legal advice — read the license.
