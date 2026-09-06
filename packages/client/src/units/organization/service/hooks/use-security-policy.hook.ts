import { type SecurityPolicy } from '@units/organization/api';
import { useSecurityPolicyQuery } from '@units/organization/service/queries';
import { type DataStatus } from '@shared/ui';

export interface SecurityPolicyView {
  /** The stored policy, once it has arrived. */
  readonly policy: SecurityPolicy | undefined;
  readonly status: DataStatus;
  readonly refetch: () => void;
}

/**
 * The stored second-factor policy, as the screen reads it.
 *
 * A thin hook over one query, and it exists because the call chain is
 * `ui → service/hooks → service/{queries,mutations} → api` (`rules/frontend-fsd.mdc` rule 4): a
 * widget calling the query object directly skips the middle link, and
 * `test/architecture/widget-call-chain.test.ts` fails on it — which is how this one came to be
 * written. What the layer buys here is small and real: `refetch` arrives as a `() => void` a retry
 * button can be handed, instead of a promise every call site has to remember to `void`.
 */
export const useSecurityPolicy = (): SecurityPolicyView => {
  const query = useSecurityPolicyQuery();

  return {
    policy: query.data,
    status: query.status,
    refetch: () => {
      void query.refetch();
    },
  };
};
