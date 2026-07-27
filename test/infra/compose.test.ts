import { describe, expect, it } from 'vitest';

import {
  alwaysOnServices,
  composeServices,
  environmentOf,
  healthcheckCommandOf,
  hostInterfaceOf,
  imageMajorOf,
  namedVolumesOf,
  publishedPortOf,
  readBootstrapSql,
  readBootstrapWrapper,
  readComposeFile,
  type ComposeService,
} from './compose-fixture.util.js';

const compose = readComposeFile();
const services = composeServices(compose);

/**
 * The `minimal` profile of ADR-0020: PostgreSQL + Redis + MinIO (plus the one-shot bucket
 * initialiser). These services declare no `profiles` key, so Compose starts them in every profile.
 */
const MINIMAL_SERVICES = ['postgres', 'redis', 'minio', 'minio-setup'] as const;

/** Services that only exist in the full (`default`) profile. */
const PROFILED_SERVICES = ['meilisearch', 'mailpit'] as const;

/** Stateful services and the named volume each one must keep its data in (ADR-0020, backup list). */
const SERVICE_VOLUMES: Record<string, string> = {
  postgres: 'pgdata',
  redis: 'redis-data',
  minio: 'minio-data',
  meilisearch: 'meili-data',
  mailpit: 'mailpit-data',
};

/** Label marking a container that runs once and exits — it cannot report a health status. */
const ONESHOT_LABEL = 'com.bad-crm.oneshot';

/** Env keys whose value is a credential and must never be written literally into the file. */
const CREDENTIAL_KEY = /(PASSWORD|SECRET|KEY|TOKEN|CREDENTIAL|ROOT_USER|_USER$)/i;

/** Subset of the above whose value is secret (a username is not) and needs a dev-only default. */
const SECRET_KEY = /(PASSWORD|SECRET|KEY|TOKEN|CREDENTIAL)/i;

/** `${VAR}` or `${VAR:-default}` — the only accepted way to supply a credential. */
const INTERPOLATED = /^\$\{[A-Z0-9_]+(:?-(?<fallback>[^}]*))?\}$/;

const isOneshot = (service: ComposeService): boolean => service.labels?.[ONESHOT_LABEL] === 'true';

const longRunningServices = services.filter(([, service]) => !isOneshot(service));

describe('docker-compose.yml — service inventory', () => {
  it('declares exactly the dev services of STORY-001-04', () => {
    expect(services.map(([name]) => name).sort()).toEqual(
      [...MINIMAL_SERVICES, ...PROFILED_SERVICES].sort(),
    );
  });

  it('omits the obsolete top-level `version` key', () => {
    expect(compose.version).toBeUndefined();
  });
});

describe('docker-compose.yml — network exposure (T-SH-02)', () => {
  it.each(services)('%s publishes every port on the loopback interface only', (_name, service) => {
    for (const mapping of service.ports ?? []) {
      expect(hostInterfaceOf(mapping)).toBe('127.0.0.1');
    }
  });

  it('publishes no port on all interfaces', () => {
    const raw = services.flatMap(([, service]) => service.ports ?? []);
    const exposed = raw.filter((mapping) => hostInterfaceOf(mapping) !== '127.0.0.1');

    expect(exposed).toEqual([]);
  });

  it.each(services)('%s takes its published port from an environment variable', (_n, service) => {
    for (const mapping of service.ports ?? []) {
      expect(String(publishedPortOf(mapping))).toMatch(INTERPOLATED);
    }
  });
});

describe('docker-compose.yml — image pinning', () => {
  it.each(services)('%s pins an explicit image version', (_name, service) => {
    const image = service.image ?? '';
    const tag = image.split(':')[1] ?? '';

    expect(image).not.toContain(':latest');
    expect(tag).not.toBe('');
    expect(tag).toMatch(/\d/);
  });

  it('runs PostgreSQL from a pgvector-enabled image', () => {
    expect(compose.services['postgres']?.image ?? '').toContain('pgvector');
  });
});

describe('docker-compose.yml — dependency licensing (AGPL-3.0)', () => {
  it('runs Redis from a release that offers AGPLv3', () => {
    // Redis 7.x is dual-licensed RSALv2 / SSPLv1 — both on the deny-list of
    // docs/legal/licensing.md §3. The AGPLv3 option only exists from Redis 8.0 onwards, and this
    // compose file ships with an AGPL-3.0 repository, so the major version is a licence assertion.
    expect(imageMajorOf(compose.services['redis'] ?? {})).toBeGreaterThanOrEqual(8);
  });
});

describe('docker-compose.yml — health and start order', () => {
  it.each(longRunningServices)('%s declares a healthcheck', (_name, service) => {
    expect(service.healthcheck?.test).toBeDefined();
  });

  it('probes PostgreSQL over TCP, not over the unix socket', () => {
    // The entrypoint runs docker-entrypoint-initdb.d against a temporary server that listens on the
    // unix socket only. A socket-local `pg_isready` is therefore green while the roles and the
    // extensions are still being created, and `compose up --wait` returns too early: the first
    // `pnpm dev` on a clean volume then fails with `role "app_user" does not exist`.
    const command = healthcheckCommandOf(compose.services['postgres'] ?? {});

    expect(command).toContain('pg_isready');
    expect(command).toMatch(/-h\s+127\.0\.0\.1/);
  });

  it.each(services)('%s waits for its dependencies to be ready', (_name, service) => {
    const dependsOn = service.depends_on ?? {};
    expect(Array.isArray(dependsOn)).toBe(false);

    for (const dependency of Object.values(dependsOn as Record<string, { condition?: string }>)) {
      expect(dependency.condition).toMatch(/^service_(healthy|completed_successfully)$/);
    }
  });
});

describe('docker-compose.yml — persistence', () => {
  it.each(Object.entries(SERVICE_VOLUMES))(
    '%s stores its data in the %s volume',
    (name, volume) => {
      expect(namedVolumesOf(compose.services[name] ?? {})).toContain(volume);
    },
  );

  it('declares every named volume it mounts', () => {
    const declared = Object.keys(compose.volumes ?? {}).sort();

    expect(declared).toEqual(Object.values(SERVICE_VOLUMES).sort());
  });
});

describe('docker-compose.yml — secrets', () => {
  it.each(services)('%s keeps credentials out of the file', (_name, service) => {
    for (const [key, value] of Object.entries(environmentOf(service))) {
      if (!CREDENTIAL_KEY.test(key)) continue;

      expect(value, `${key} must come from an environment variable`).toMatch(INTERPOLATED);
    }
  });

  it.each(services)('%s marks every fallback secret as development-only', (_name, service) => {
    for (const [key, value] of Object.entries(environmentOf(service))) {
      if (!SECRET_KEY.test(key)) continue;

      const fallback = INTERPOLATED.exec(value)?.groups?.['fallback'];
      if (fallback === undefined || fallback === '') continue;

      expect(fallback, `${key} fallback must be an obvious dev-only value`).toMatch(/^dev[_-]/);
    }
  });

  it('contains no CHANGE_ME marker (those belong in .env.example)', () => {
    const raw = JSON.stringify(compose);

    expect(raw).not.toContain('CHANGE_ME');
  });
});

describe('docker-compose.yml — profiles (ADR-0020)', () => {
  it('starts exactly the minimal profile when no profile is enabled', () => {
    expect(alwaysOnServices(compose).sort()).toEqual([...MINIMAL_SERVICES].sort());
  });

  it.each(PROFILED_SERVICES)('%s stays down in the minimal profile', (name) => {
    expect(compose.services[name]?.profiles).toEqual(['default', 'full']);
  });

  it('keeps Meilisearch out of the minimal profile so search can degrade to Postgres FTS', () => {
    expect(alwaysOnServices(compose)).not.toContain('meilisearch');
  });
});

describe('00-bootstrap-roles.sql — role attributes are re-asserted, not only set at creation', () => {
  const sql = readBootstrapSql();

  /** The file with `--` comment lines dropped: what psql actually executes. */
  const executable = sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

  /** Everything after the `DO $$ … END $$;` block: the part that runs on every invocation. */
  const unconditional = sql.slice(sql.indexOf('END $$;'));

  it('refuses to run without the password variables', () => {
    // A manual run without `-v migrator_pw=…` would otherwise leave LOGIN roles with a password
    // nobody chose. The guard has to raise: `\quit 1` looks right but psql 16 answers
    // `warning: \quit: extra argument "1" ignored` and exits 0 — a guard that reports success.
    for (const variable of ['migrator_pw', 'app_pw', 'auth_pw', 'backup_pw', 'db_name']) {
      expect(sql, `${variable} must be guarded`).toMatch(
        new RegExp(String.raw`\\if\s+:\{\?${variable}}`),
      );
    }

    expect(executable).toMatch(/RAISE EXCEPTION/);
    expect(executable, '`\\quit <code>` exits 0 in psql — it cannot fail a run').not.toMatch(
      /\\quit\s+\d/,
    );
  });

  it.each(['app_migrator', 'app_user', 'app_auth', 'backup_role'])(
    're-asserts NOINHERIT on %s outside the creation branch',
    (role) => {
      expect(unconditional).toMatch(new RegExp(`ALTER ROLE ${role}\\s+[^;]*\\bNOINHERIT\\b`));
    },
  );

  it('re-asserts BYPASSRLS on app_auth even when the role already existed', () => {
    expect(unconditional).toMatch(/ALTER ROLE app_auth\s+[^;]*\bBYPASSRLS\b/);
  });

  it('re-asserts NOBYPASSRLS on the two roles that must stay subject to RLS', () => {
    expect(unconditional).toMatch(/ALTER ROLE app_user\s+[^;]*\bNOBYPASSRLS\b/);
    expect(unconditional).toMatch(/ALTER ROLE app_migrator\s+[^;]*\bNOBYPASSRLS\b/);
  });

  it('strips any pre-existing membership between the four roles so SET ROLE stays impossible', () => {
    // NOINHERIT only stops rights from being inherited automatically; a member can still SET ROLE.
    expect(unconditional).toMatch(/pg_auth_members/);
    expect(unconditional).toMatch(/REVOKE %I FROM %I/);

    for (const role of ['app_migrator', 'app_user', 'app_auth', 'backup_role']) {
      expect(unconditional.slice(unconditional.indexOf('pg_auth_members'))).toContain(`'${role}'`);
    }
  });

  it('creates the backup role the runbooks depend on', () => {
    // docs/runbooks/backup-restore.md dumps as backup_role: under FORCE ROW LEVEL SECURITY a dump
    // taken as the table owner silently produces partial data.
    expect(sql).toContain('backup_role');
    expect(unconditional).toMatch(/ALTER ROLE backup_role\s+[^;]*\bBYPASSRLS\b/);
    expect(unconditional).toMatch(/GRANT CONNECT ON DATABASE .* TO [^;]*backup_role/);
    expect(unconditional).toMatch(/GRANT\s+USAGE ON SCHEMA public TO [^;]*backup_role/);
  });
});

describe('00-bootstrap-roles.sh — the wrapper both entry points share', () => {
  const wrapper = readBootstrapWrapper();

  it('connects to a maintenance database rather than to the one it may have to create', () => {
    // The bootstrap creates the application database when it is absent (`\gexec`), which is the
    // whole reason it comes first in the restore procedure. Connecting to that database to do so
    // fails with `database "bad_crm" does not exist` on exactly the host where it matters — a new
    // one, or one where the database was just dropped for a clean restore.
    expect(wrapper).toMatch(/--dbname\s+"?\$\{?(BOOTSTRAP_)?MAINTENANCE_DB/);
    expect(wrapper).toMatch(/postgres/);
  });

  it('can reach the server over TCP when it does not share its filesystem', () => {
    // `pnpm db:bootstrap` runs as a one-off container so that a rotated password is actually read
    // from .env; that container has no unix socket to the server and needs a host and a password.
    expect(wrapper).toMatch(/PGHOST/);
    expect(wrapper).toMatch(/PGPASSWORD/);
  });
});
