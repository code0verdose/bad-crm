import { type SecurityPolicy } from '@units/organization/api';
import { useSecurityPolicyQuery } from '@units/organization/service/queries';
import { type DataStatus } from '@shared/ui';

export interface SecurityPolicyView {
  /** The stored policy, once it has arrived. */
  readonly policy: SecurityPolicy | undefined;
  readonly status: DataStatus;
  readonly refetch: () => Promise<unknown>;
}

/**
 * The stored second-factor policy, as the screen reads it.
 *
 * A thin hook over one query, and it exists because the call chain is
 * `ui → service/hooks → service/{queries,mutations} → api` (`rules/frontend-fsd.mdc` rule 4): a
 * widget calling the query object directly skips the middle link, and
 * `test/architecture/widget-call-chain.test.ts` fails on it — which is how this one came to be
 * written. `refetch` returns the reload's promise on purpose: the retry button of `DataState` stays
 * busy, and keeps focus, until it settles (`shared/ui/data-state/use-retry.hook.ts`), so a
 * `() => void` that swallowed it would be a compile error rather than a button that is never busy.
 */
export const useSecurityPolicy = (): SecurityPolicyView => {
  const query = useSecurityPolicyQuery();

  return {
    policy: query.data,
    status: query.status,
    refetch: () => query.refetch(),
  };
};
