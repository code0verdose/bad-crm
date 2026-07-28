declare const currentTx: () => {
  team: { create: (args: unknown) => Promise<unknown> };
  $transaction: (work: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
};

/**
 * The positive control for the two repository bans, and the reason they had to be written narrowly.
 *
 * Everything here *mentions* the tenant and none of it takes one: `organizationId()` reads the
 * scope opened by `withTenant`, `this.organizationId()` is a call and not a parameter, and the
 * column still has to be written into the row — a rule keyed on the name alone would forbid the
 * only correct shape a repository has.
 */
export abstract class ScopedRepository {
  /** The organization of the scope in effect. Derived, never received. */
  protected abstract organizationId(): string;

  createTeam(name: string): Promise<unknown> {
    return currentTx().team.create({ data: { name, organizationId: this.organizationId() } });
  }

  /** The interactive form of `$transaction` is the sanctioned one; only the array form is banned. */
  createInBatch(name: string): Promise<unknown> {
    return currentTx().$transaction((tx) => Promise.resolve({ tx, name }));
  }
}
