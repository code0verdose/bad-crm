import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { fetchRecoveryCodeStatus, type RecoveryCodeStatus } from '@units/auth/api';
import { QueryKeys } from '@shared/lib';

/**
 * How many recovery codes are left — and, by inference, whether 2FA is on at all.
 *
 * **The inference is deliberate and it is the only one available.** No operation in the contract
 * reports enrolment state: neither the session document nor `GET /me` carries `totpEnabledAt`, and
 * `POST /auth/2fa/setup` answers `409 mfa_already_enabled` only after it has been called. What is
 * safe to lean on is the transaction: `confirm` sets `totpEnabledAt` **and** issues ten codes
 * together, and `regenerate` replaces ten with ten — so `total > 0` is true exactly when an
 * enrolment exists. The gap is written up for the epic rather than papered over here.
 *
 * The `signal` is passed on because a query is always cancellable — leaving the screen while this
 * is in flight must not leave a request to answer into a dead tree (`rules/tanstack-query.mdc` §4).
 *
 * No `placeholderData`: there is one address and no filter, so nothing exists to keep from the
 * previous answer.
 */
export const useRecoveryCodeStatusQuery = (): UseQueryResult<RecoveryCodeStatus, Error> =>
  useQuery({
    queryKey: QueryKeys.RecoveryCodes.status(),
    queryFn: ({ signal }) => fetchRecoveryCodeStatus(signal),
    staleTime: 30_000,
  });
