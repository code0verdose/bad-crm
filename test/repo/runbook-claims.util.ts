import { NON_SCRIPT_COMMANDS } from '../rules/declared-checks.util.js';

/**
 * The kinds of instruction this reader is willing to take out of a runbook.
 *
 * A runbook is the only document in this repository somebody acts on **with their hands, on a
 * production host, on the worst day that installation has**. It is also the document that rots
 * without ever being edited: `/healthz` and `/readyz` were written before the probes had names,
 * survived the commit that named them `/health` and `/ready`, and stood on twenty-one lines of five
 * runbooks until a hand sweep removed them on 2026-08-30 (`git grep -c '/healthz\|/readyz' 8cf9418^
 * -- docs/runbooks`) — because nothing that reads a runbook reads code, and nothing that reads code
 * reads runbooks. `stale-claims-auditor` does not
 * close that gap — its trigger is two waves over one delta, and a runbook goes stale from somebody
 * else's commit.
 *
 * Every kind here resolves against a namespace that is **closed in this checkout**, which is the
 * whole reason the list is this short. The runbooks describe an installation of a product at
 * EPIC-013 of forty-nine, so a great deal of what they name belongs to an epic that has not run —
 * and it is the *reading*, not the namespaces, that decides whether that is bearable. Measured:
 * these same seven shapes matched over the whole document instead of inside a code span, against
 * these same namespaces, report **737 findings** over the nine runbooks. A gate red on that many is
 * deleted in its first week rather than obeyed. See `KIND_NOTES` for what each namespace is and why
 * it can be closed.
 */
export type ClaimKind =
  'command' | 'compose-service' | 'env' | 'route' | 'metric' | 'audit-action' | 'identifier';

/** Why each kind is safe to resolve today — quoted into the report, and asserted non-empty. */
export const KIND_NOTES: Readonly<Record<ClaimKind, string>> = {
  command:
    'The `scripts` of the root manifest and of every workspace package. `pnpm <name>` in a runbook ' +
    'is a line an operator pastes into a shell, so it resolves right now or it is wrong right now; ' +
    'package-manager verbs and locally installed binaries are named in `FOREIGN_COMMANDS`.',
  'compose-service':
    'The service keys of `docker-compose.yml` — the only compose file in the tree. A name that is ' +
    'not one of them is a container `docker compose logs` will refuse to find, which is how ' +
    '`app` survived: no reader compared the argument against the file that defines the arguments.',
  env:
    'Everything this installation reads: `.env.example`, the fields of both zod schemas — server ' +
    'and client, deliberately separate — the interpolations of `docker-compose.yml`, and every ' +
    '`process.env` access in the sources, scripts and Playwright harness. A name none of them ' +
    'carries is read by nothing; psql, libpq and shell variables are named in `FOREIGN_ENV`.',
  route:
    'The `path` literals of `route-registry.factory.ts`, which is the single place a route is ' +
    'declared, plus the service paths of `service-route-allow-list.constant.ts`. The second half ' +
    'contributes nothing today — the registry declares `/health`, `/ready` and `/metrics` itself, ' +
    'and the only path the allow-list adds is `/socket.io`, which no prefix here can produce.',
  metric:
    'The `name` of every collector this server registers in `prom-client.adapter.ts` — not the ' +
    'whole exposition, which also carries the `nodejs_*` and `process_*` series of ' +
    '`collectDefaultMetrics`. No runbook cites one of those; the day one does, it belongs here ' +
    "rather than in `FOREIGN_METRICS`, which is for PostgreSQL's own statistics columns.",
  'audit-action':
    'The closed `AUDIT_ACTIONS` list of `packages/shared`. The list is closed on purpose — an ' +
    'action named at a call site is an action nobody reviewed — so a filter a runbook tells an ' +
    'operator to run over the trail either matches the name in that list or silently matches nothing.',
  identifier:
    'Prisma models plus every `PascalCase` class, interface, type, function or const exported by ' +
    '`packages/*/src`. A runbook names a ' +
    'table and the class an operator will grep for in the same sentence shape, so the question this ' +
    'checkout can answer is whether the name exists at all; platform names are in `FOREIGN_IDENTIFIERS`.',
};

export interface RunbookClaim {
  /** File name of the runbook, e.g. `upgrade.md`. */
  readonly runbook: string;
  readonly kind: ClaimKind;
  /** The resolved identifier: a script name, a service, a variable, a path, a series, a model. */
  readonly identifier: string;
  /** The code span it came from, so a failure names the line that has to change. */
  readonly span: string;
}

/** Stable, human-readable key — what the pending registry is keyed on. */
export const claimKey = (claim: RunbookClaim): string =>
  `${claim.runbook} · ${claim.kind} · ${claim.identifier}`;

export interface CodeSpan {
  /** One line of a fenced block, or the content of one inline span. */
  readonly text: string;
  /** The fence language, or `null` for an inline span — the two are read differently. */
  readonly language: string | null;
  /** For an inline span, the plain text preceding it on its line; empty inside a fence. */
  readonly lead: string;
}

/** A fenced block, or an inline span — matched in one pass so the two stay in document order. */
const CODE = /```(\w*)\n([\s\S]*?)```|`([^`\n]+)`/g;

/**
 * The fenced blocks and inline spans of a document, and nothing between them.
 *
 * `test/rules/declared-checks.util.ts` reads a **table cell** and explains at length why it reads
 * nothing else: the prose of a rule argues, only the table claims. A runbook has no such table —
 * what it has is fenced blocks an operator copies and backticked tokens naming what to look at.
 * This is the same discipline applied to the other genre, and the measurement says the same thing:
 * over these nine files the same detectors reading the whole document instead of a code span
 * produce 737 findings, of which the overwhelming majority are SQL aliases (`c.relname`), prose
 * mentions and file names read as audit actions, variables and models. None of them is something
 * an operator types.
 *
 * A fenced block is split into lines, so that what a failure quotes is the command that has to
 * change rather than the forty-seven-line Caddyfile it sits inside. Inline spans carry their
 * `lead` — the words immediately before them — for the same reason `declared-checks.util.ts` reads by
 * adjacency: what a backticked token *is* is decided by the phrase that introduces it.
 *
 * Fences are matched in the same pass as inline spans and consumed whole, so a backtick inside a
 * shell heredoc cannot open a span that swallows the rest of the document.
 */
export const codeSpans = (markdown: string): CodeSpan[] => {
  const spans: CodeSpan[] = [];

  for (const match of markdown.matchAll(CODE)) {
    const body = match[2];

    if (body !== undefined) {
      for (const line of body.split('\n')) {
        if (line.trim() !== '')
          spans.push({ text: line.trim(), language: match[1] ?? '', lead: '' });
      }
      continue;
    }

    const lineStart = markdown.lastIndexOf('\n', match.index) + 1;
    const before = markdown.slice(lineStart, match.index);

    spans.push({
      text: match[3] ?? '',
      language: null,
      // Only as far back as the previous span on this line: the words that introduce this token.
      lead: before.slice(before.lastIndexOf('`') + 1),
    });
  }

  return spans;
};

/**
 * Package-manager verbs and binaries that are not `scripts` of any manifest.
 *
 * The rule tables resolve the same class of token, so the shared half is imported rather than
 * retyped. One addition, and it is the one this corpus actually writes: `pnpm exec` in front of a
 * locally installed binary. The rest of pnpm's verb list is deliberately absent — an exemption
 * granted before a runbook asked for it is an exemption nobody reviewed.
 */
export const FOREIGN_COMMANDS: Readonly<Record<string, string>> = {
  ...NON_SCRIPT_COMMANDS,
  exec: 'a pnpm built-in verb that runs a locally installed binary, not a script of any manifest',
};

/**
 * Variables an operator sets that this installation does not define.
 *
 * One entry, because one is what the corpus contains — the list is observed rather than guessed.
 * A speculative entry would be an exemption granted before anything asked for it, and the whole
 * value of this shape of registry is that every line of it is a decision somebody reviewed.
 */
export const FOREIGN_ENV: Readonly<Record<string, string>> = {
  ON_ERROR_STOP: 'a psql variable set with `-v`; it aborts a script on the first failing statement',
};

/**
 * Paths shaped like ours that belong to another service on the same host.
 *
 * The reader strips the origin before it reads a path, which is what makes
 * `http://localhost:3000/health` resolve at all — and is also why a neighbour's API on the same
 * prefix arrives here looking like ours. There is exactly one of those, and it is named rather
 * than pattern-matched: a rule that skipped every path seen on a non-default port would skip the
 * product's own endpoints in every example that names a port.
 */
export const FOREIGN_ROUTES: Readonly<Record<string, string>> = {
  '/api/v1/messages':
    "Mailpit's own REST API on port 8025, read while checking that a letter was actually sent",
};

/**
 * Identifiers ending in a Prometheus suffix that are not series this server exposes.
 *
 * A suffix is a naming convention, not a namespace, and PostgreSQL uses the same words: without
 * this list a column of a statistics view quoted in a sizing calculation reads as an alert on a
 * metric nobody exports.
 */
export const FOREIGN_METRICS: Readonly<Record<string, string>> = {
  wal_bytes: "a column of `pg_stat_wal`, PostgreSQL's own statistics view, quoted while sizing WAL",
};

/**
 * `PascalCase` names a runbook mentions that belong to the platform rather than to this checkout.
 *
 * The list is short because the namespace behind the `identifier` claim is wide — a symbol this
 * workspace exports counts. What is left over is what a runbook borrows from JavaScript, the web
 * platform or a vendor API while explaining why a step is written the way it is.
 */
export const FOREIGN_IDENTIFIERS: Readonly<Record<string, string>> = {
  TypeError: 'a JavaScript built-in error constructor, quoted from a stack trace',
  SharedArrayBuffer: 'a web-platform global; the runbook explains which isolation headers it needs',
  AsyncLocalStorage:
    'a class of the Node.js `async_hooks` module, quoted while explaining context propagation',
  HeadBucket: 'an S3 API operation name, quoted from an AWS SDK error',
};

/** `pnpm <script>`, past the flags and the `run` verb that may sit between them. */
const PNPM_COMMAND =
  /(?:^|[\s;&|(])pnpm\s+(?:(?:--filter|-F)\s+\S+\s+|run\s+|-[rw]\s+|--silent\s+)*([a-z][a-z0-9-]*(?::[a-z0-9-]+)*)/g;

const commandClaimsOf = (runbook: string, span: CodeSpan): RunbookClaim[] =>
  [...span.text.matchAll(PNPM_COMMAND)]
    .map((match) => match[1] as string)
    .filter((identifier) => FOREIGN_COMMANDS[identifier] === undefined)
    .map((identifier) => ({ runbook, kind: 'command' as const, identifier, span: span.text }));

/** Compose subcommands that take service names as their positional arguments. */
const SERVICE_SUBCOMMANDS = new Set([
  'up',
  'down',
  'logs',
  'exec',
  'run',
  'restart',
  'stop',
  'start',
  'ps',
  'port',
  'pull',
  'push',
  'images',
  'kill',
  'build',
  'create',
  'rm',
  'top',
  'stats',
]);

/** Subcommands whose *first* positional argument is the service and whose rest is a command line. */
const SINGLE_SERVICE_SUBCOMMANDS = new Set(['exec', 'run', 'port', 'top']);

/**
 * Flags that take their value as the next token.
 *
 * Only the ones this corpus uses, and deliberately without `-f`, `-t` and `-p`: after `logs` those
 * are `--follow`, `--timestamps` and… nothing, and consuming the token after `-f` would eat the
 * service name of `docker compose logs -f api`.
 */
const VALUE_FLAGS = new Set([
  '--since',
  '--until',
  '--tail',
  '--profile',
  '--entrypoint',
  '--user',
  '-u',
  '--env',
  '-e',
  '--workdir',
  '-w',
  '--index',
  '--project-name',
  '--project-directory',
  '--file',
  '--scale',
  '--timeout',
]);

/** A service name as compose accepts it. */
const SERVICE_NAME = /^[a-z][a-z0-9_-]*$/;

/** Shell syntax that ends the argument list: a pipe, a redirection, a comment, a continuation. */
const endsArguments = (token: string): boolean =>
  ['|', '>', '<', '#', '&', ';', '\\'].some((symbol) => token.startsWith(symbol));

/**
 * The services one `docker compose …` invocation names, by position rather than by search.
 *
 * Positional is the entire discipline. A reader that grepped a compose line for known-looking words
 * would file `psql`, `redis-cli`, `sh` and `ps.txt` as services; a reader that skipped tokens it did
 * not recognise instead of stopping would walk past `<имя-сервиса-прокси>` into whatever the
 * operator was told to pipe the output through.
 */
const composeServicesIn = (line: string): string[] => {
  const start = line.indexOf('docker compose');

  if (start === -1) return [];

  const tokens = line
    .slice(start + 'docker compose'.length)
    .trim()
    .split(/\s+/)
    .filter((token) => token !== '');

  let index = 0;

  // Global flags may precede the subcommand (`docker compose --profile minimal up -d`); none of
  // their values is a subcommand, so scanning forward to the first one that is cannot overshoot.
  while (index < tokens.length && !SERVICE_SUBCOMMANDS.has(tokens[index] as string)) index += 1;

  const subcommand = tokens[index];

  if (subcommand === undefined) return [];

  const services: string[] = [];

  for (index += 1; index < tokens.length; index += 1) {
    const token = tokens[index] as string;

    if (endsArguments(token)) break;

    if (token.startsWith('-')) {
      if (VALUE_FLAGS.has(token)) index += 1;
      continue;
    }

    if (!SERVICE_NAME.test(token)) break;

    services.push(token);

    if (SINGLE_SERVICE_SUBCOMMANDS.has(subcommand)) break;
  }

  return services;
};

const composeClaimsOf = (runbook: string, span: CodeSpan): RunbookClaim[] =>
  span.text.split('\n').flatMap((line) =>
    composeServicesIn(line).map((identifier) => ({
      runbook,
      kind: 'compose-service' as const,
      identifier,
      span: line.trim(),
    })),
  );

/**
 * A variable named in the shape an operator writes one: assigned, interpolated, or quoted alone.
 *
 * Not «every `UPPER_SNAKE` token in a code span»: SQL keywords, psql meta-commands and the option
 * names of half the tools a runbook drives are shouted too, and the whole-text measurement filed
 * every one of them. These three shapes are the ones that mean «this is a variable».
 */
const ENV_ASSIGNMENT = /(?:^|[\s;&|("'])([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)=/gm;
const ENV_INTERPOLATION = /\$\{?([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\}?/g;
const ENV_ALONE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

const envClaimsOf = (runbook: string, span: CodeSpan): RunbookClaim[] => {
  const names =
    span.language === null && ENV_ALONE.test(span.text.trim())
      ? [span.text.trim()]
      : [
          ...[...span.text.matchAll(ENV_ASSIGNMENT)].map((match) => match[1] as string),
          ...[...span.text.matchAll(ENV_INTERPOLATION)].map((match) => match[1] as string),
        ];

  return names
    .filter((identifier) => FOREIGN_ENV[identifier] === undefined)
    .map((identifier) => ({ runbook, kind: 'env' as const, identifier, span: span.text }));
};

/** An origin, removed before paths are read so that `http://localhost:3000/health` yields `/health`. */
const ORIGIN = /https?:\/\/[^\s/"'`]*/g;

/**
 * A path this server could answer on: rooted, and opening with one of the four prefixes it serves.
 *
 * Greedy past the prefix on purpose — `/healthz` has to come out as `/healthz` and fail, not
 * quietly fail to match and pass. The left boundary is what keeps
 * `infrastructure/metrics/prom-client.adapter.ts` from being read as a route.
 */
const HTTP_PATH = /(?<![\w.-])(\/(?:api\/v1|health|ready|metrics)[\w{}:./-]*)/g;

const routeClaimsOf = (runbook: string, span: CodeSpan): RunbookClaim[] =>
  [...span.text.replace(ORIGIN, '').matchAll(HTTP_PATH)]
    .map((match) => (match[1] as string).replace(/[.,;:]+$/, ''))
    // OpenAPI writes `{userId}` where Express writes `:userId`; the registry is the namespace.
    .map((path) => path.replace(/\{(\w+)\}/g, ':$1'))
    .filter((identifier) => FOREIGN_ROUTES[identifier] === undefined)
    .map((identifier) => ({ runbook, kind: 'route' as const, identifier, span: span.text }));

/** A series, with any label selector the alert wrote around it dropped. */
const METRIC_ALONE = /^([a-z][a-z0-9_]*_(?:total|seconds|bytes))(?:\{[^}]*\})?$/;

/**
 * Metrics are read from inline spans only, and that is not an oversight.
 *
 * A fenced block in these runbooks is shell, SQL, or a configuration file (`conf`, `caddyfile`,
 * `nginx`), and the first two are full of identifiers ending in the same three words —
 * `pg_total_relation_size(...)`, a `wal_bytes` column in a `SELECT` list. An alert is written about
 * a series by naming it; a query merely uses one.
 */
const metricClaimsOf = (runbook: string, span: CodeSpan): RunbookClaim[] => {
  if (span.language !== null) return [];

  const identifier = METRIC_ALONE.exec(span.text.trim())?.[1];

  if (identifier === undefined || FOREIGN_METRICS[identifier] !== undefined) return [];

  return [{ runbook, kind: 'metric', identifier, span: span.text }];
};

/** `<subject>.<verb>`, exactly one dot and nothing else in the span. */
const AUDIT_ACTION_ALONE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

/**
 * Words that introduce an audit action rather than a file, a column or a property.
 *
 * The shape alone is worthless here, and that is measured: read by shape, these nine runbooks
 * offer `install.md`, `turbo.json`, `postgresql.conf`, `err.stack`, `it.only`,
 * `organizations.owner_id` and `pg_stat_archiver.last_failed_time` as audit actions — eighteen
 * false names against the four real ones. What separates them is the sentence around the token.
 */
const AUDIT_LEAD = /(?:записи|записью|запись|действие|действия|действием|action)[\s:—-]*$/iu;

/**
 * An audit action, from a quoted literal in a SQL block or from an inline span the prose announces.
 *
 * The SQL half is where an operator actually uses one — `WHERE action IN ('session.signed_in', …)`
 * — and restricting it to a *quoted literal* is what keeps `c.relname` and `p.polrelid` out: a
 * table alias is never quoted, and a quoted string is never an alias.
 */
const auditActionClaimsOf = (runbook: string, span: CodeSpan): RunbookClaim[] => {
  const names =
    span.language === null
      ? AUDIT_LEAD.test(span.lead) && AUDIT_ACTION_ALONE.test(span.text.trim())
        ? [span.text.trim()]
        : []
      : span.language === 'sql'
        ? [...span.text.matchAll(/'([^']+)'/g)]
            .map((match) => match[1] as string)
            .filter((token) => AUDIT_ACTION_ALONE.test(token))
        : [];

  return names.map((identifier) => ({
    runbook,
    kind: 'audit-action' as const,
    identifier,
    span: span.text,
  }));
};

/** `PascalCase` with at least two segments — the shape of a model and of a class alike. */
const IDENTIFIER_ALONE = /^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+$/;

const identifierClaimsOf = (runbook: string, span: CodeSpan): RunbookClaim[] => {
  if (span.language !== null) return [];

  const identifier = span.text.trim();

  if (!IDENTIFIER_ALONE.test(identifier)) return [];
  if (FOREIGN_IDENTIFIERS[identifier] !== undefined) return [];

  return [{ runbook, kind: 'identifier', identifier, span: span.text }];
};

/** Every machine-checkable instruction of one runbook. */
export const runbookClaims = (runbook: string, markdown: string): RunbookClaim[] =>
  codeSpans(markdown).flatMap((span) => [
    ...commandClaimsOf(runbook, span),
    ...composeClaimsOf(runbook, span),
    ...envClaimsOf(runbook, span),
    ...routeClaimsOf(runbook, span),
    ...metricClaimsOf(runbook, span),
    ...auditActionClaimsOf(runbook, span),
    ...identifierClaimsOf(runbook, span),
  ]);
