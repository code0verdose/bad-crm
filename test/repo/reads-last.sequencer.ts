/** The file whose assertions need every other suite to have run — see `AUDIT_FILE` below. */
const AUDIT_FILE = 'test/repo/workspace-layout.test.ts';

interface TestSpecification {
  readonly moduleId: string;
}

/**
 * Runs the read-registry audit last, and everything else in a stable order.
 *
 * `workspace-layout.test.ts` checks the set of files the suite actually read against the `inputs`
 * of `//#test:repo`. That set is filled in by the other suites as they read, so the audit is only
 * meaningful once they are done — which is a scheduling property, not something an assertion can
 * arrange for itself. Vitest's default sequencer orders by file size and by the durations of the
 * previous run, so "it happens to be alphabetically last" is not an order anyone declared.
 *
 * Ordering alone is not enough: the registry lives in module state, so the files also have to share
 * one module graph (`isolate: false`, `singleFork: true` in `vitest.config.ts`). The audit asserts
 * that it can see reads made by the other suites, so removing either half of the arrangement fails
 * loudly instead of shrinking the audit to its own two reads.
 */
export class ReadsLastSequencer {
  /** Sharding would split the suite across machines and with it the registry; it is not used. */
  public async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    return files;
  }

  public async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const isAudit = (file: TestSpecification): boolean => file.moduleId.endsWith(AUDIT_FILE);

    return [...files].sort((a, b) => {
      if (isAudit(a) !== isAudit(b)) return isAudit(a) ? 1 : -1;
      return a.moduleId < b.moduleId ? -1 : 1;
    });
  }
}
