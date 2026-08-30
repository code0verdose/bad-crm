/**
 * A sign-in attempt whose password can be read exactly once.
 *
 * `useMutation` keeps `state.variables` for as long as the mutation is in the cache, and the cache
 * travels in the router context, which `@tanstack/router-core` publishes as `self.__TSR_ROUTER__`
 * under no development flag. `login.mutation.ts` already maps the *answer* so no token is kept there;
 * this is the same rule applied to the *arguments*, which are an address and a password.
 *
 * `gcTime: 0` was the previous answer and is not enough. It evicts once nothing observes the
 * mutation — and the second-factor step keeps that observer mounted for as long as the person is
 * typing a code. That is precisely the window worth stealing: the entry held both halves of a
 * working credential, reachable by three property reads, for the whole of it (found 2026-08-30 by
 * reading the cache in `test/routes/sign-in-flow.test.tsx` rather than by reasoning about it).
 *
 * So the password never becomes a mutation variable. What travels is this object: an address, which
 * the form has on screen anyway, and a closure that hands the password over once and forgets it.
 * After `mutationFn` has read it the cache entry holds `null`, whatever anybody does with it.
 *
 * Reading twice is a programming error rather than a retry: mutations here are not retried (no
 * `retry` is configured for them), so a second read means two callers believed they owned the same
 * attempt. It answers `null`, and the caller refuses — quietly re-sending a password that was
 * supposed to be spent would be the worse of the two.
 */
export interface LoginAttempt {
  readonly email: string;
  /** The password, once. Every later call answers `null`. */
  readonly takePassword: () => string | null;
}

export const loginAttempt = (email: string, password: string): LoginAttempt => {
  let secret: string | null = password;

  return {
    email,
    takePassword: () => {
      const value = secret;

      secret = null;

      return value;
    },
  };
};
