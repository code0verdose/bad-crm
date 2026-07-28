import { Pool } from 'pg';

import {
  readRlsCatalog,
  rlsCatalogViolations,
} from '../src/infrastructure/persistence/prisma/rls-catalog.util.js';
import {
  describeConnection,
  renderRlsReport,
} from '../src/infrastructure/persistence/prisma/rls-report.util.js';
import { TENANT_TABLES } from '../src/infrastructure/persistence/prisma/tenant-tables.constant.js';

/**
 * `pnpm check:rls` — invariant 1 of CLAUDE.md, verified against a database that already exists.
 *
 * The integration suite (`test/integration/db/migrations.test.ts`) makes the same assertions, and
 * neither replaces the other: that suite starts its own container and can only ever judge the
 * migration this checkout carries. This is the operator's tool — it points at a host. The case it
 * exists for is written down in `docs/security/rls-design.md` («Проверка политики на снапшоте
 * прод-объёма», step 3) and in `docs/runbooks/backup-restore.md`: a production backup has just
 * been restored into staging, and the question is whether the restore kept tenant isolation.
 * `pg_restore --no-privileges` and a hand-repaired schema are exactly the situations where a
 * policy comes back without its `WITH CHECK`, or a table without its `FORCE` — neither of which
 * changes how the application behaves.
 *
 * The template it compares against lives in `rls-catalog.constant.ts`, which the integration suite
 * reads too. There is deliberately no second copy of it here.
 *
 * Reads only. Every query is a `SELECT` over `pg_catalog`, which is world-readable, so any role
 * that can connect can run this — including `app_user`. The registry side of the comparison comes
 * from this checkout, so run it from the revision that is deployed on the host being checked.
 */

const USAGE = `usage: pnpm check:rls -- <connection string>
       DATABASE_URL=postgresql://... pnpm check:rls

Reads pg_catalog only; no privilege beyond connecting is required.`;

// `pnpm check:rls -- <url>` forwards the separator itself to the script, so the first argument is
// `--` and the connection string is the second. Filtering rather than indexing keeps the documented
// invocation and the direct `tsx scripts/check-rls.ts <url>` on the same code path.
const connectionString =
  process.argv.slice(2).find((argument) => argument !== '--') ?? process.env['DATABASE_URL'] ?? '';

if (connectionString === '') {
  process.stderr.write(
    `no connection string: pass one as an argument or set DATABASE_URL\n\n${USAGE}\n`,
  );
  process.exit(2);
}

const pool = new Pool({ connectionString, max: 1 });

try {
  const facts = await readRlsCatalog(async <Row>(sql: string): Promise<Row[]> => {
    const result = await pool.query(sql);

    return result.rows as Row[];
  });

  const { rows } = await pool.query<{ role: string }>('SELECT current_user::text AS role');
  const findings = rlsCatalogViolations(facts);
  const tenantTables = new Set([...Object.keys(TENANT_TABLES), ...facts.tenantColumnTables]);

  process.stdout.write(
    `${renderRlsReport(findings, {
      target: describeConnection(connectionString),
      role: rows[0]?.role ?? 'unknown',
      tables: tenantTables.size,
      policies: facts.policies.length,
    })}\n`,
  );

  process.exitCode = findings.length === 0 ? 0 : 1;
} catch (error) {
  // Exit 2, not 1: "the check could not run" and "the database is wrong" are different answers,
  // and a wrapper that treats an unreachable host as a passing or failing policy check is worse
  // than one that stops. The message and not the stack — the stack of a connection refusal says
  // nothing an operator can act on.
  process.stderr.write(
    `check:rls could not run: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}\n`,
  );
  process.exitCode = 2;
} finally {
  await pool.end();
}
