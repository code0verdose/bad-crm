import { readdirSync } from 'node:fs';

/**
 * The migration folders shipped with this build, in the order Prisma names them.
 *
 * Read once, at composition, and never on a probe: the set is fixed for a build, and an
 * orchestrator polling `/ready` every couple of seconds must not put a directory listing on that
 * path.
 *
 * **It throws when the directory cannot be read, and that is the point.** A build that cannot find
 * its own migrations is broken, and the alternative — logging and carrying on without the check —
 * is the failure mode this whole story is about: an instance that reports itself ready while the
 * database has the wrong shape. Startup is where that has to be said, loudly, once.
 */
export const shippedMigrationNames = (migrationsDirectory: string): readonly string[] =>
  readdirSync(migrationsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
