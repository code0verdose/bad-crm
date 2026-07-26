# Security Policy

Bad CRM is a self-hosted workspace that stores what a development team considers most sensitive:
project data, personal data, credentials to infrastructure, and an end-to-end encrypted secrets
vault. We take reports seriously and we would rather hear about a problem from you than from an
incident.

> **Current phase: design.** There is no code, no release, and no Docker image yet — the repository
> contains specification only. That means there is nothing deployed to attack, but the security
> design *is* reviewable, and design-level reports are explicitly in scope (see
> [Scope](#scope)). Everything below describes the policy that applies now and continues to apply
> once code exists.

---

## Supported versions

| Version | Status | Security fixes |
|---|---|---|
| *(none released)* | Design phase — no releases exist | n/a |

Once releases begin, this table will list the supported lines. The intended policy:

- The **latest minor release** always receives security fixes.
- The **previous minor release** receives fixes for High and Critical issues for 90 days after the
  next minor ships.
- Older versions receive nothing. Self-hosted installations are expected to stay reasonably current;
  see [`docs/runbooks/upgrade.md`](docs/runbooks/upgrade.md).

---

## Reporting a vulnerability

**Do not open a public issue, discussion, or pull request for a security problem.** Public disclosure
before a fix exists puts every installation at risk.

**Preferred channel:** GitHub **Private vulnerability reporting** (Security → Report a vulnerability)
on this repository. It is private, it produces an advisory draft, and it lets us credit you.

**Alternative channel:** email `SECURITY_CONTACT_PLACEHOLDER@example.com`.

<!--
  MAINTAINER TODO: before the first public release, replace the placeholder above with a real
  address, publish a PGP key here, and enable GitHub private vulnerability reporting on the repo.
-->

### What to include

The more of this you can provide, the faster the fix:

- The affected component and, if you know it, the file or endpoint.
- The version, commit hash, or deployment you tested against.
- A step-by-step reproduction, ideally with a minimal proof of concept.
- What an attacker gains: which data, whose data, across which boundary (own organization, another
  organization, the whole installation).
- Which precondition the attack needs — unauthenticated, any authenticated user, an organization
  admin, the host owner.
- Your assessment of severity, and whether you intend to publish.

### What to expect from us

| Stage | Target |
|---|---|
| Acknowledgement that we received the report | 3 business days |
| Initial triage: confirmed / not reproducible / out of scope, with severity | 10 business days |
| Fix or a concrete remediation plan with dates for High and Critical | 30 days |
| Public advisory after a fix is available | Coordinated with you |

If a stage is going to slip, we will tell you rather than go quiet.

### Safe harbour

We will not pursue or support legal action against anyone who makes a good-faith effort to comply
with this policy: research on **your own installation**, no access to other people's data, no
degradation of anyone's service, no social engineering, and no public disclosure before the
coordinated date. If you are unsure whether something is in bounds, ask first.

There is no bug bounty. This is a volunteer open-source project; we offer credit in the advisory and
our genuine thanks.

---

## Scope

### In scope

- **Cross-tenant data access** of any kind — this is the highest-severity class in the product. A
  missing RLS policy, a missing `WITH CHECK`, a query outside `withTenant`, a search index that
  returns another organization's documents.
- **Authorization flaws**: privilege escalation, a permission check that exists in middleware but
  not in the use-case, an endpoint that ignores resource ACLs, list endpoints leaking rows the caller
  may not see, an API that acts as an oracle for the existence of other organizations' entities.
- **Authentication and session flaws**: refresh token reuse not being detected, session fixation,
  token leakage, 2FA bypass, password reset abuse.
- **E2EE vault weaknesses**: any path by which plaintext, a master password, or key material reaches
  the server, the logs, telemetry, the search index, or AI context; nonce reuse; missing AAD;
  algorithm or parameter downgrade accepted by the client; access revocation without key rotation.
- **Secure link flaws**: guessable tokens, links that survive their one-time use, links readable
  without the fragment secret.
- **Injection and traversal**: SQL injection, command injection, path traversal, SSRF, XSS in
  documents, knowledge base notes, comments, or chat.
- **File storage flaws**: presigned URLs issued without a permission check, excessive TTLs, object
  keys that let one tenant read another's objects.
- **Prompt injection with a security consequence** — content that makes the AI assistant retrieve or
  reveal data the user is not entitled to.
- **Insecure defaults that ship in our compose file, Dockerfile, or `.env.example`** — a default
  credential, a service bound to a public interface, a permissive CORS setting.
- **Secrets committed to the repository**, or written to logs, telemetry, or audit records.
- **Design flaws in the specification** — a hole in [`docs/security/threat-model.md`](docs/security/threat-model.md),
  [`docs/security/rls-design.md`](docs/security/rls-design.md),
  [`docs/security/permission-model.md`](docs/security/permission-model.md), or
  [`docs/security/e2ee-design.md`](docs/security/e2ee-design.md). During the design phase this is
  the most valuable report we can receive.

### Out of scope

- **The host owner's access to their own installation.** Bad CRM is self-hosted: whoever controls the
  server, the database, the disk, the backups, or the served JavaScript can reach the data of every
  organization on that host, with the sole exception of vault ciphertext. This is the deployment
  model, not a vulnerability. It is documented as residual risk RR-02 in the threat model. If an
  installation serves legally separate companies, the honest answer is separate instances.
- **Attacks requiring a compromised endpoint** — malware on the user's machine, a malicious browser
  extension, a physically unlocked device.
- **Misconfiguration of a specific installation** — an open PostgreSQL port, no TLS, a weak
  administrator password, ignoring [`docs/runbooks/install.md`](docs/runbooks/install.md). We will
  happily accept it as a documentation issue, not as a vulnerability.
- **Social engineering** of maintainers, contributors, or users.
- **Denial of service through raw volume** (traffic floods, resource exhaustion by an authenticated
  user with legitimate quota). An amplification bug where one cheap request causes disproportionate
  server work *is* in scope.
- **Vulnerabilities in third-party dependencies without a demonstrated path** through Bad CRM. Report
  those upstream; if you can show exploitation through our code, that is in scope.
- **Findings from automated scanners with no demonstrated impact** — missing headers on endpoints
  that serve no content, version disclosure, "weak" TLS ciphers that are not actually enabled.
- **Anything against an installation you do not own or have permission to test.**

---

## Coordinated disclosure

We follow **coordinated disclosure with a 90-day deadline**.

1. You report privately; we acknowledge and triage.
2. We develop and test a fix, and where practical, ship it together with a way for administrators to
   detect whether they were affected.
3. We publish a release and a security advisory, with a CVE where applicable, crediting you unless
   you ask us not to.
4. **The advisory becomes public no later than 90 days after the report**, whether or not the fix is
   complete. If the fix lands earlier, we publish earlier — usually within days of the release, to
   give self-hosted administrators time to upgrade.
5. If a vulnerability is being actively exploited, we shorten the timeline and publish mitigation
   guidance immediately, before the fix if necessary.

If we go unresponsive for 30 days after your report, you are free to disclose publicly. We would
rather that than a silently unpatched installation.

Advisories are published as GitHub Security Advisories on this repository and referenced in
[`CHANGELOG.md`](CHANGELOG.md).

---

## The E2EE vault: what is and is not guaranteed

The vault is the part of the product with the strongest promise, so it deserves the most precise
statement of that promise. The authoritative documents are
[`docs/security/e2ee-design.md`](docs/security/e2ee-design.md) (key hierarchy, primitives,
lifecycle) and [`docs/security/threat-model.md`](docs/security/threat-model.md) (threats and residual
risks). This section summarizes them; where they disagree with this summary, they win.

### What we do guarantee

- **The server stores ciphertext and metadata only.** Keys are derived from the user's master
  password in the browser and used there. The master password is never transmitted.
- **An installation administrator cannot read a user's personal vault.** Database access, disk
  access, and backup access all yield ciphertext.
- Encryption uses **XChaCha20-Poly1305-IETF** with per-item keys, key derivation uses **Argon2id**
  with parameters that the client verifies rather than trusts, sharing uses **`crypto_box_seal`**,
  and grants are **Ed25519**-signed. One audited library (`libsodium-wrappers-sumo`) provides all of
  it.
- **Revoking access rotates the key.** Revocation is not merely a flag on a row.
- Vault content **never enters the search index, embeddings, logs, telemetry, or AI context** — this
  is enforced architecturally (the AI context has no port to the vault context, and the test suite
  fails on an import across that boundary), not by a code review habit.
- A **Recovery Kit** lets a user regain access after forgetting the master password, and an
  organization escrow exists for shared vaults. Both are explicit, opt-in, and documented.

### What we do not guarantee

- **Web E2EE cannot protect you from a malicious or compromised server.** The server sends the
  JavaScript that performs the encryption. An installation owner who modifies that JavaScript can
  capture the master password on the next unlock. This is a fundamental limitation of browser-based
  end-to-end encryption, not a bug we have not fixed yet, and it is stated plainly in the design
  document. Trust in a vault implies trust in whoever operates and updates the installation.
- **Metadata leaks.** Item titles, URLs, folder structure, sizes, timestamps, who shared what with
  whom, and access frequency are visible to the server. Only secret values are encrypted. Do not put
  sensitive information in item names.
- **Key substitution during sharing.** The server distributes public keys, so a malicious server can
  substitute one when you share an item. There is no out-of-band key verification in the current
  design (residual risk RR-01).
- **Blind-index search leaks statistics.** Searchable encrypted fields expose repetition patterns to
  frequency analysis. We accept this trade-off consciously and document it.
- **Revocation does not un-know a secret.** Someone who read a secret before you revoked their access
  still knows it. Revoke, then **rotate the actual credential** — the vault cannot do that for you.
- **A backup is useless without user keys.** Restoring the database restores ciphertext. If every
  user has forgotten their master password and has no Recovery Kit, the data is gone permanently and
  no backup changes that. See [`docs/runbooks/backup-restore.md`](docs/runbooks/backup-restore.md).
- **Nothing prevents a user from pasting a secret somewhere else** — into the AI chat, a comment, a
  document. We warn; we do not block.
- **The vault has not been externally audited.** An independent review is planned before 1.0
  (EPIC-045, milestone M9). Until then, treat the implementation as unreviewed by anyone outside the
  project.

---

## Self-hosting security checklist

The complete procedure is in [`docs/runbooks/install.md`](docs/runbooks/install.md), which is the
authoritative version. The short form:

- [ ] **Nothing but the reverse proxy is reachable from the internet.** PostgreSQL (5432), Redis
      (6379), MinIO (9000/9001), and Meilisearch (7700) must be bound to the Docker network or
      `127.0.0.1` only — never published to `0.0.0.0`. Verify from outside the host, not from inside.
- [ ] **TLS in front of the application**, with HSTS, and `APP_URL` set to the `https://` address.
- [ ] **Every default changed**: the PostgreSQL password, the MinIO root credentials, the Meilisearch
      master key. The `.env.example` placeholders (`CHANGE_ME_…`) must not survive into production.
- [ ] **`APP_ENCRYPTION_KEY` and `JWT_SECRET` generated with a CSPRNG** (`openssl rand -base64 32`),
      unique per installation, and stored somewhere you can recover them from — losing
      `APP_ENCRYPTION_KEY` makes stored integration credentials unrecoverable.
- [ ] **The application's database role has no `BYPASSRLS`** and does not own the tables. Migrations
      run under a separate owner role.
- [ ] **Backups configured, encrypted, stored off the host, and test-restored.** A backup nobody has
      restored is a hypothesis. Note that `FORCE ROW LEVEL SECURITY` changes how you must take the
      dump — see [`docs/runbooks/backup-restore.md`](docs/runbooks/backup-restore.md).
- [ ] **`APP_ENCRYPTION_KEY` is not stored on the same host as the only copy of the backups.**
- [ ] **The owner account has 2FA enabled** as soon as TOTP is available.
- [ ] **Upgrades applied promptly**, following [`docs/runbooks/upgrade.md`](docs/runbooks/upgrade.md).
- [ ] **Logs and audit records reviewed periodically**, and log storage treated as sensitive.
- [ ] **An incident plan exists** before you need it: [`docs/runbooks/incident.md`](docs/runbooks/incident.md).

---

## Security documentation index

| Document | What it covers |
|---|---|
| [`docs/security/threat-model.md`](docs/security/threat-model.md) | Attackers N1–N8, STRIDE per context, top 15 threats, residual risks, prompt injection, self-host specifics, personal data |
| [`docs/security/rls-design.md`](docs/security/rls-design.md) | Database roles, the canonical RLS policy template, `withTenant`, isolation tests, known limitations |
| [`docs/security/permission-model.md`](docs/security/permission-model.md) | The five-layer permission model, effective permission computation, role × endpoint matrix |
| [`docs/security/e2ee-design.md`](docs/security/e2ee-design.md) | Key hierarchy, primitives and parameters, lifecycle, blind index, secure links, developer rules |
| [`CLAUDE.md`](CLAUDE.md) | The three inviolable invariants and what may never be logged, indexed, or sent to AI |
