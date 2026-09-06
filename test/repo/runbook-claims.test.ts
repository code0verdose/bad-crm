import { describe, expect, it } from 'vitest';

import {
  FOREIGN_COMMANDS,
  FOREIGN_ENV,
  FOREIGN_IDENTIFIERS,
  FOREIGN_METRICS,
  FOREIGN_ROUTES,
  KIND_NOTES,
  claimKey,
  codeSpans,
  runbookClaims,
  type ClaimKind,
  type RunbookClaim,
} from './runbook-claims.util.js';
import { PACKAGE_DIRS, listRepoFiles, readJson, readRepoFile } from './repo-fixture.util.js';

interface PackageJson {
  scripts?: Record<string, string>;
}

/**
 * Computes a namespace on first use and keeps it.
 *
 * Not an optimisation for its own sake: the `identifier` namespace walks every source file of the
 * workspace, and the assertions below resolve four hundred claims each. Recomputed per claim, the
 * suite spends eight seconds per assertion and times out — which reads as a broken gate rather than
 * a slow one, and is how a gate gets deleted.
 */
const once = <T>(compute: () => T): (() => T) => {
  let value: T | undefined;

  return () => (value ??= compute());
};

const MANIFESTS = [
  'package.json',
  ...Object.values(PACKAGE_DIRS).map((dir) => `${dir}/package.json`),
];

/** Every `scripts` key of the workspace — the surface `pnpm <name>` resolves against. */
const scriptNames = once(
  () =>
    new Set(MANIFESTS.flatMap((path) => Object.keys(readJson<PackageJson>(path).scripts ?? {}))),
);

/**
 * Service keys of `docker-compose.yml`, and only of that file.
 *
 * Sliced between `services:` and `volumes:` rather than parsed as YAML for one reason: a volume is
 * declared at the same indentation as a service, so a whole-document read would answer «yes, there
 * is a `pgdata`» to `docker compose logs pgdata`, which is not a thing that can be run.
 */
const composeServices = once((): Set<string> => {
  const compose = readRepoFile('docker-compose.yml');
  const services = compose.slice(compose.indexOf('\nservices:'), compose.indexOf('\nvolumes:'));

  return new Set(
    [...services.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((match) => match[1] ?? ''),
  );
});

const SERVER_ENV_SCHEMA = 'packages/server/src/infrastructure/bootstrap/env.schema.ts';
const CLIENT_ENV_SCHEMA = 'packages/client/src/shared/config/env.schema.ts';

/**
 * Sources outside the two schemas that read an environment variable of their own.
 *
 * Every path here is already hashed into the `inputs` of `//#test:repo`, and that is a constraint
 * on the list rather than a coincidence: a suite that reads what its cache key does not cover
 * reports a PASS over the previous version of the file it never re-read.
 */
const ENV_READER_ROOTS: readonly string[] = [
  ...Object.values(PACKAGE_DIRS).map((dir) => `${dir}/src`),
  'packages/server/scripts',
  'packages/e2e/fixtures',
  'scripts',
];

/**
 * Every variable this installation knows: the template an operator copies, both zod schemas, the
 * compose file, and every `process.env` read in the sources.
 *
 * All of them, because they are different surfaces and a runbook may legitimately name a variable
 * from any one. `POSTGRES_PASSWORD` is consumed by the database image and never reaches the server
 * schema; `VITE_API_BASE_URL` is inlined into the browser bundle and never reaches the server's;
 * `E2E_BROWSERS` is read by the Playwright config and belongs to no schema at all. A name none of
 * them contains is a name nothing reads — which is the whole question a runbook line raises.
 */
const envNames = once((): Set<string> => {
  const names = new Set<string>();

  const add = (source: string, pattern: RegExp): void => {
    for (const match of source.matchAll(pattern)) names.add(match[1] ?? '');
  };

  add(readRepoFile('.env.example'), /^([A-Z][A-Z0-9_]*)=/gm);
  add(readRepoFile(SERVER_ENV_SCHEMA), /^ {2}([A-Z][A-Z0-9_]*):/gm);
  add(readRepoFile(CLIENT_ENV_SCHEMA), /^ {2}([A-Z][A-Z0-9_]*):/gm);
  add(readRepoFile('docker-compose.yml'), /\$\{([A-Z][A-Z0-9_]*)/g);

  /**
   * A variable read in TypeScript, in the three shapes this workspace writes.
   *
   * The bracketed form on an arbitrary `…env` identifier is not laxity: `seed.ts` reads
   * `rawEnv['SEED_ALLOW_PRODUCTION']` from a parsed copy, and a pattern anchored on `process.env`
   * would call a variable the seed genuinely reads a variable nothing reads.
   */
  const READ =
    /(?:(?:process|import\.meta)\.env\.([A-Z][A-Z0-9_]*)|\w*[eE]nv\[['"]([A-Z][A-Z0-9_]*)['"]\])/g;
  /** A variable a shell script sets or exports — `scripts/docker/testcontainers-env.sh`. */
  const SHELL = /(?:^|[\s;("'])([A-Z][A-Z0-9_]*)=|\bexport\s+((?:[A-Z][A-Z0-9_]*[ \t]*)+)/gm;

  const readSource = (path: string): void => {
    const source = readRepoFile(path);

    for (const [, dotted, indexed] of source.matchAll(READ)) {
      if (dotted !== undefined) names.add(dotted);
      if (indexed !== undefined) names.add(indexed);
    }

    if (!path.endsWith('.sh')) return;

    for (const [, assigned, exported] of source.matchAll(SHELL)) {
      if (assigned !== undefined) names.add(assigned);
      for (const name of (exported ?? '').split(/\s+/)) if (name !== '') names.add(name);
    }
  };

  for (const root of ENV_READER_ROOTS) {
    for (const path of listRepoFiles(root)) {
      if (/\.(?:ts|tsx|sh)$/.test(path)) readSource(path);
    }
  }

  // Playwright's own config and global setup live at the package root, beside no `src`.
  for (const path of listRepoFiles('packages/e2e')) {
    if (/^packages\/e2e\/[^/]+\.ts$/.test(path)) readSource(path);
  }

  return names;
});

const ROUTE_REGISTRY = 'packages/server/src/presentation/http/route-registry.factory.ts';
const SERVICE_ROUTE_ALLOW_LIST =
  'packages/server/test/contract/service-route-allow-list.constant.ts';

/**
 * Every path this server answers on, read as text rather than by constructing the registry.
 *
 * Building it would mean starting the server's composition root from the repository suite, which
 * owns no application code and has no database. The declarations are literals in one file — the
 * single place a route is declared at all — so the text is the same closed namespace the factory
 * would produce, with `${API_PREFIX}` substituted for the constant it interpolates.
 */
const routePaths = once((): Set<string> => {
  const registry = readRepoFile(ROUTE_REGISTRY);
  const paths = [...registry.matchAll(/path: [`']([^`']+)[`']/g)].map((match) =>
    (match[1] ?? '').replace('${API_PREFIX}', '/api/v1'),
  );
  const service = [...readRepoFile(SERVICE_ROUTE_ALLOW_LIST).matchAll(/path: '([^']+)'/g)].map(
    (match) => match[1] ?? '',
  );

  // The prefix itself: runbooks name it where a base URL is configured (`VITE_API_BASE_URL`),
  // and no declaration carries it alone.
  return new Set([...paths, ...service, '/api/v1']);
});

const METRICS_ADAPTER = 'packages/server/src/infrastructure/metrics/prom-client.adapter.ts';

const metricNames = once(
  () =>
    new Set(
      [...readRepoFile(METRICS_ADAPTER).matchAll(/name: '([a-z][a-z0-9_]*)'/g)].map(
        (match) => match[1] ?? '',
      ),
    ),
);

const AUDIT_ACTIONS = 'packages/shared/src/audit/audit-action.enums.ts';

const auditActionNames = once(
  () =>
    new Set(
      [
        ...readRepoFile(AUDIT_ACTIONS).matchAll(/^ {2}'([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)',$/gm),
      ].map((match) => match[1] ?? ''),
    ),
);

const PRISMA_SCHEMA = 'packages/server/prisma/schema.prisma';

/**
 * Prisma models, plus every `PascalCase` class, interface, type, function or const the sources of
 * this workspace export.
 *
 * The wider half is deliberate and is what makes the claim readable at all. A runbook writes
 * `` `AuditLog` `` for a table and `` `SearchPort` `` for the interface an operator will grep for,
 * in the same sentence shape; a namespace of models alone would call the second one a lie. What
 * the repository *can* answer about a `PascalCase` name in a procedure is whether this checkout
 * defines it anywhere — a renamed model, a deleted class and an invented name all fail that, which
 * is the failure this gate exists for. Names belonging to the platform rather than to this
 * checkout are enumerated in `FOREIGN_IDENTIFIERS`, with the reason each one is not ours.
 */
const definedIdentifiers = once((): Set<string> => {
  const names = new Set(
    [...readRepoFile(PRISMA_SCHEMA).matchAll(/^model (\w+)/gm)].map((match) => match[1] ?? ''),
  );

  for (const dir of Object.values(PACKAGE_DIRS)) {
    for (const path of listRepoFiles(`${dir}/src`)) {
      if (!path.endsWith('.ts') && !path.endsWith('.tsx')) continue;

      for (const [, klass, konst] of readRepoFile(path).matchAll(
        // `function` is in the alternation deliberately: the client exports most of its
        // components that way, so a reader without it would call `AppErrorScreen` a name this
        // checkout does not define — and send the next author to write a PENDING entry for
        // something the product ships.
        /export (?:abstract )?(?:class|interface|type|function) (\w+)|export const (\w+)\s*[=:]/g,
      )) {
        if (klass !== undefined) names.add(klass);
        if (konst !== undefined) names.add(konst);
      }
    }
  }

  return names;
});

const RUNBOOK_DIR = 'docs/runbooks';

const runbookFiles = (): string[] =>
  listRepoFiles(RUNBOOK_DIR)
    .filter((path) => path.endsWith('.md'))
    .sort();

const allClaims = once((): RunbookClaim[] =>
  runbookFiles().flatMap((path) =>
    runbookClaims(path.slice(`${RUNBOOK_DIR}/`.length), readRepoFile(path)),
  ),
);

const isSatisfied = (claim: RunbookClaim): boolean => {
  switch (claim.kind) {
    case 'command':
      return scriptNames().has(claim.identifier);
    case 'compose-service':
      return composeServices().has(claim.identifier);
    case 'env':
      return envNames().has(claim.identifier);
    case 'route':
      return routePaths().has(claim.identifier);
    case 'metric':
      return metricNames().has(claim.identifier);
    case 'audit-action':
      return auditActionNames().has(claim.identifier);
    case 'identifier':
      return definedIdentifiers().has(claim.identifier);
  }
};

/**
 * Names a runbook uses that this repository does not own yet — every one of them, with the reason.
 *
 * The registry is the price of gating a set of documents that describe an installation the product
 * does not ship yet. A capacity table naming `outbox_lag_seconds` is not a lie; it is the alert the
 * epic that writes the queue will be held to, and the runbook already says so in prose. What is not
 * acceptable is that state being invisible to the gate. Invisible is how `docker compose logs app`
 * survived in a document whose own preamble lists the services that file defines, and how
 * `/healthz` and `/readyz` stood on twenty-one lines of five runbooks after the commit that named
 * the endpoints `/health` and `/ready`.
 *
 * The deal is the one `test/rules/declared-checks.test.ts` makes: a runbook may outrun the code,
 * but only in writing. An undeclared gap fails below — and so does a declared gap that has since
 * been closed, because an entry describing a hole somebody filled is the same lying document
 * pointing the other way.
 */
const PENDING: Readonly<Record<string, string>> = {
  // ── the production compose file, which EPIC-017 is what first publishes ──────────────────────
  'backup-restore.md · compose-service · api':
    'The application services live in the production compose file, and there is no ' +
    '`docker-compose.prod.yml` in the tree: `docker-compose.yml` starts the backing services a ' +
    'developer needs and runs the server from `pnpm dev`. Self-host packaging is EPIC-017.',
  'backup-restore.md · compose-service · worker':
    'Same file that does not exist yet: the worker process is started by the production compose of ' +
    'EPIC-017. There is no queue in the tree at all yet — `RUN_WORKERS_IN_PROCESS` is a flag the ' +
    'environment schema already carries for the day there is one.',
  'incident.md · compose-service · api': 'See `backup-restore.md · compose-service · api`.',
  'incident.md · compose-service · worker': 'See `backup-restore.md · compose-service · worker`.',
  'install.md · compose-service · api': 'See `backup-restore.md · compose-service · api`.',
  'tracing-a-request.md · compose-service · api':
    'See `backup-restore.md · compose-service · api`.',
  'upgrade.md · compose-service · api': 'See `backup-restore.md · compose-service · api`.',
  'upgrade.md · compose-service · worker': 'See `backup-restore.md · compose-service · worker`.',
  'install.md · compose-service · migrate': 'See `upgrade.md · compose-service · migrate`.',
  'upgrade.md · compose-service · migrate':
    'The one-shot migration service of the production compose (`docker compose run --rm migrate`). ' +
    'Locally the same step is `pnpm db:migrate`, which needs no service; the container arrives with ' +
    'EPIC-017 together with `api` and `worker`.',

  // ── metrics the runbooks already mark as absent in their own prose ───────────────────────────
  'hosting.md · metric · outbox_lag_seconds':
    'The age of the oldest unprocessed outbox event. There is no outbox and no queue in the tree — ' +
    'ADR-0021 is a decision taken ahead of the epic that implements it — and the alert table says ' +
    '«метрики ещё нет (2026-08-30)» in the row itself.',
  'hosting.md · metric · bullmq_jobs_total':
    'The dead-letter counter of the BullMQ workers, in the same alert table and marked absent the ' +
    'same way. No `bullmq` package is installed: the queue arrives with the outbox epic.',

  // ── routes of domains that are not built ───────────────────────────────────────────────────
  'hosting.md · route · /api/v1/ai/':
    'The reverse-proxy examples give the assistant stream its own location so buffering can be ' +
    'turned off on it. There is no `ai` context in the tree — the assistant is M4 (EPIC-048) — so ' +
    'the prefix is configured ahead of the routes that will answer under it.',
  'tracing-a-request.md · route · /api/v1/tasks/:taskId':
    'The worked example of a request identifier follows a task fetch, because that is the shape a ' +
    'reader recognises. Tasks are M3, so the template names a route nothing answers on yet — the ' +
    'sentence quoting it says only that `route` holds a template rather than a URL, not that this ' +
    'particular one is hypothetical.',

  // ── placeholders of the template that documents a new variable ──────────────────────────────
  'upgrade.md · env · EXAMPLE_VAR':
    'Not a variable of this installation: a row of the «vX.Y.Z — YYYY-MM-DD (шаблон)» table in §7, ' +
    'showing the shape in which a new variable is documented. The four names are deliberately unreal.',
  'upgrade.md · env · OTHER_VAR':
    'See `upgrade.md · env · EXAMPLE_VAR` — the optional-variable row.',
  'upgrade.md · env · OLD_VAR': 'See `upgrade.md · env · EXAMPLE_VAR` — the removed-variable row.',
  'upgrade.md · env · CHANGED_VAR':
    'See `upgrade.md · env · EXAMPLE_VAR` — the row for a variable whose format changed.',

  // ── models of domains that are not built ─────────────────────────────────────────────────────
  'hosting.md · identifier · FileVersion':
    'A row of the capacity table: file versions are what makes object storage grow. There is no ' +
    'file domain — EPIC-015 — so the model is named ahead of the migration that creates it.',
  'hosting.md · identifier · TimeEntry':
    'The same table, sizing the row count of time tracking. Time entries are M3; ADR-0016 fixes the ' +
    'single-entry model ahead of the epic.',
  'hosting.md · identifier · DocPage':
    'The same table, sizing document storage. The document domain is M3 (BlockNote, ADR-0012).',
  'hosting.md · identifier · SearchPort': 'See `install.md · identifier · SearchPort`.',
  'upgrade.md · identifier · SearchPort':
    'Named in the note about the Meilisearch volume, and named there precisely because it does not ' +
    'exist: the note explains that a version bump breaks an installation on the `default` profile ' +
    'and that the cost of that is zero today, while nothing fills the index. See ' +
    '`install.md · identifier · SearchPort`.',
  'install.md · identifier · SearchPort':
    'Named as the seam Meilisearch is plugged into when the search epic degrades to postgres-fts. ' +
    'There is no search adapter in the tree; the port arrives with it.',
};

describe('the reader takes code out of a runbook and nothing else', () => {
  const FIXTURE = [
    '# Fixture',
    '',
    'Прозой: pnpm no-such-script, /healthz и DATABASE_URL без обратных кавычек — не заявки.',
    '',
    'Запустите `pnpm db:migrate`, затем `docker compose logs api worker`.',
    '',
    '```bash',
    'docker compose exec -T postgres psql -U app_user -d bad_crm',
    'docker compose logs --no-color --since 24h app | grep x',
    'docker compose run --rm --no-deps --entrypoint sh minio-setup -c "x"',
    'docker compose ps > ps.txt',
    'docker compose logs <имя-сервиса-прокси>',
    'curl -fsS http://localhost:3000/health',
    'APP_ENCRYPTION_KEY=$(openssl rand -base64 32)',
    '```',
    '',
    'Метрика `http_requests_total`, запись `session.signed_in` в `AuditLog`, поле `${JWT_SECRET}`.',
    '',
    'Файл `packages/server/src/infrastructure/metrics/prom-client.adapter.ts` — не маршрут.',
  ].join('\n');

  const fixtureClaims = (): RunbookClaim[] => runbookClaims('fixture.md', FIXTURE);

  const identifiers = (kind: ClaimKind): string[] =>
    fixtureClaims()
      .filter((claim) => claim.kind === kind)
      .map((claim) => claim.identifier);

  it('splits a document into fenced blocks and inline spans', () => {
    // Seven lines of the one fenced block, each its own span, so a failure quotes a command.
    expect(codeSpans(FIXTURE).filter((span) => span.language === 'bash')).toHaveLength(7);
    expect(codeSpans(FIXTURE).filter((span) => span.language === null).length).toBeGreaterThan(5);
  });

  /**
   * The false positive that would end this test: prose read as a claim. The first paragraph names a
   * script, a path and a variable that do not exist, and none of them is inside a code span — which
   * is the entire difference between a document that instructs and a document that explains.
   */
  it('reads nothing out of prose', () => {
    expect(identifiers('command')).not.toContain('no-such-script');
    expect(identifiers('route')).not.toContain('/healthz');
    expect(identifiers('env')).not.toContain('DATABASE_URL');
  });

  it('reads the script of a pnpm invocation', () => {
    expect(identifiers('command')).toEqual(['db:migrate']);
  });

  it('reads the service arguments of a compose invocation, past its flags', () => {
    expect(identifiers('compose-service')).toEqual([
      'api',
      'worker',
      'postgres',
      'app',
      'minio-setup',
    ]);
  });

  /**
   * Two false positives at once. `ps.txt` is a redirection target, not a service — a reader that
   * did not stop at `>` would file it as one. `<имя-сервиса-прокси>` is a placeholder the operator
   * substitutes, and a reader that skipped unrecognised tokens instead of stopping would walk past
   * it into whatever came next.
   */
  it('stops a compose invocation at a redirection and at a placeholder', () => {
    expect(identifiers('compose-service')).not.toContain('ps.txt');
    expect(identifiers('compose-service')).not.toContain('grep');
  });

  it('reads a variable that is assigned or interpolated', () => {
    expect(identifiers('env')).toEqual(['APP_ENCRYPTION_KEY', 'JWT_SECRET']);
  });

  it('reads an HTTP path out of a URL, and not out of a file path', () => {
    expect(identifiers('route')).toEqual(['/health']);
  });

  it('reads a metric, an audit action and a model named as themselves', () => {
    expect(identifiers('metric')).toEqual(['http_requests_total']);
    expect(identifiers('audit-action')).toEqual(['session.signed_in']);
    expect(identifiers('identifier')).toEqual(['AuditLog']);
  });
});

describe('every runbook claim resolves against this checkout', () => {
  /**
   * The floor, and the reason every green below means anything at all.
   *
   * A reader that stopped reading — a changed fence syntax, a renamed directory, a regex that
   * quietly matches nothing — passes every assertion in this file over an empty set, and reports
   * «0 расхождений» in exactly the voice of a gate that checked the whole corpus. The number is a
   * floor rather than an equality so that deleting one line of a runbook is not a failing test.
   */
  it('extracts a non-trivial number of claims', () => {
    expect(allClaims().length).toBeGreaterThan(150);
  });

  it('reads every runbook in the directory', () => {
    expect(runbookFiles().length).toBeGreaterThan(5);

    const covered = new Set(allClaims().map((claim) => claim.runbook));

    expect(
      runbookFiles().filter((path) => !covered.has(path.slice(`${RUNBOOK_DIR}/`.length))),
    ).toEqual([]);
  });

  it.each([
    ['backup-restore.md', 'command', 'db:migrate'],
    ['local-environment.md', 'compose-service', 'postgres'],
    ['install.md', 'env', 'APP_ENCRYPTION_KEY'],
    ['hosting.md', 'metric', 'http_requests_total'],
    ['incident.md', 'identifier', 'AuditLog'],
    ['incident.md', 'audit-action', 'session.signed_in'],
    ['install.md', 'route', '/health'],
  ])('extracts the %s claim about `%s %s`', (runbook, kind, identifier) => {
    expect(allClaims().map(claimKey)).toContain(`${runbook} · ${kind} · ${identifier}`);
  });

  /**
   * The control on each detector, both ways round. Without the negative half a detector that
   * resolves everything looks like a document with nothing wrong in it; without the positive half a
   * detector that resolves nothing looks like a document that is entirely wrong.
   */
  it.each([
    ['command', 'db:migrate', true],
    ['command', 'db:migrat', false],
    ['compose-service', 'postgres', true],
    ['compose-service', 'app', false],
    ['env', 'DATABASE_URL', true],
    ['env', 'DATABASE_URI', false],
    ['route', '/health', true],
    ['route', '/healthz', false],
    ['route', '/api/v1/auth/login', true],
    ['route', '/api/v1/auth/signin', false],
    ['metric', 'http_requests_total', true],
    ['metric', 'http_request_total', false],
    ['audit-action', 'session.signed_in', true],
    ['audit-action', 'session.signed_out', false],
    ['identifier', 'AuditLog', true],
    ['identifier', 'AuditLogs', false],
  ] as const)('resolves the %s claim `%s` to %s', (kind, identifier, expected) => {
    expect(isSatisfied({ runbook: 'fixture.md', kind, identifier, span: '' })).toBe(expected);
  });

  it('holds every claim the repository has not declared as pending', () => {
    const broken = allClaims()
      .filter((claim) => !isSatisfied(claim))
      .filter((claim) => PENDING[claimKey(claim)] === undefined);

    expect(
      broken.map((claim) => `${claimKey(claim)}  ←  ${claim.span}`),
      'a runbook instructs an operator to use something this checkout does not have',
    ).toEqual([]);
  });

  /**
   * The direction that actually rots. An entry describing a service, a metric or a model somebody
   * has since shipped turns this registry into the thing it exists to prevent — a document
   * asserting something about the repository that stopped being true.
   */
  it('declares nothing as pending that already exists', () => {
    const satisfied = new Set(allClaims().filter(isSatisfied).map(claimKey));

    expect(
      Object.keys(PENDING).filter((key) => satisfied.has(key)),
      'shipped since; remove the entry from PENDING',
    ).toEqual([]);
  });

  it('declares nothing as pending that the reader no longer produces', () => {
    const known = new Set(allClaims().map(claimKey));

    expect(
      Object.keys(PENDING).filter((key) => !known.has(key)),
      'the runbook no longer says this; remove the entry from PENDING',
    ).toEqual([]);
  });

  it('gives every pending claim a reason long enough to be one', () => {
    for (const [key, reason] of Object.entries(PENDING)) {
      expect(reason.length, key).toBeGreaterThan(40);
    }
  });

  it.each([
    ...Object.entries(FOREIGN_COMMANDS),
    ...Object.entries(FOREIGN_ENV),
    ...Object.entries(FOREIGN_METRICS),
    ...Object.entries(FOREIGN_ROUTES),
    ...Object.entries(FOREIGN_IDENTIFIERS),
  ])('explains why `%s` belongs to another system', (_name, reason) => {
    expect(reason.length).toBeGreaterThan(20);
  });

  it.each(Object.entries(KIND_NOTES))(
    'documents the namespace behind the %s claim',
    (_kind, note) => {
      expect(note.length).toBeGreaterThan(80);
    },
  );
});
