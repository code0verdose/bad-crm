import { Prisma, type PrismaClient } from '@prisma/client';

/**
 * How much disk the audit trail occupies, partitions and their indexes together.
 *
 * ## Why the partitions and not the table
 *
 * `pg_total_relation_size('audit_logs')` answers **zero**, for the whole life of an installation: a
 * partitioned parent has no storage of its own, and every byte of the journal is in a leaf. A metric
 * written the obvious way would sit flat at nothing and alert on nothing, which is worse than no
 * metric — it is a dashboard saying the thing it was installed to watch is not happening.
 *
 * ## Why this is readable by `app_user`, which owns nothing here
 *
 * Every partition is `REVOKE ALL ... FROM app_user` — that revocation is what makes the trail
 * append-only, and it is why a size query looks like it should fail. It does not:
 * `pg_total_relation_size` reads the catalogue and the relation's files, and requires no privilege
 * on the relation named. `test/integration/db/audit-log-size.test.ts` asserts that against a live
 * database as `app_user`, because "requires no privilege" is exactly the kind of claim that is true
 * until a major version decides otherwise.
 *
 * ## Why the default partition is included
 *
 * It is a partition, its rows are on the same disk, and it is where the journal lands when nobody
 * ran `pnpm db:audit-partitions` — the case where the number matters most.
 *
 * `pg_inherits` rather than `pg_partition_tree`: one level is all this table has, and the catalogue
 * view is available on every PostgreSQL this product supports.
 */
export const AUDIT_LOG_BYTES_SQL = `
  SELECT coalesce(sum(pg_total_relation_size(child.inhrelid)), 0)::text AS bytes
    FROM pg_inherits AS child
   WHERE child.inhparent = 'public.audit_logs'::regclass`;

/** Just enough of a client to run the statement — a whole `PrismaClient` is not what this needs. */
export type AuditLogSizeClient = Pick<PrismaClient, '$queryRaw'>;

/**
 * The reading behind `audit_log_partition_bytes`.
 *
 * Returns bytes as a number: PostgreSQL answers `bigint`, which Prisma hands over as a string or a
 * `BigInt` depending on the driver, and a Prometheus gauge takes neither. The cast is here rather
 * than at the gauge so that the unit is decided in the one place that knows what was asked.
 */
export const createAuditLogBytesReader =
  (client: AuditLogSizeClient) => async (): Promise<number> => {
    // `Prisma.raw` over a module constant, not over anything a caller supplied: the statement takes
    // no parameters at all, and the same text is what the integration suite runs through `pg`.
    const rows = await client.$queryRaw<{ bytes: string }[]>(Prisma.raw(AUDIT_LOG_BYTES_SQL));

    return Number(rows[0]?.bytes ?? 0);
  };
