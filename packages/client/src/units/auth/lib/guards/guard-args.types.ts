import { type GuardSessionStatus } from '@units/auth/model';

/**
 * The subset of `beforeLoad` arguments a guard actually reads.
 *
 * Structural on purpose, and narrow on purpose. The router hands `beforeLoad` a large object built
 * in `app/` — the query client, the matched route, the params, an abort signal — and a guard that
 * named that type would have to import it from `app/`, which is a dependency pointing up the layers
 * (`rules/frontend-fsd.mdc` rule 1). Naming only the two fields it reads keeps the arrow pointing
 * down, and keeps a guard callable from a test with two literals instead of a router stood up to
 * produce the other twenty fields.
 *
 * Narrowness is not a loss of checking here, it is where the checking happens: parameters are
 * compared contravariantly, so the router's real context has to satisfy this shape at the call site
 * in `app/routes/**` — including its `status`, which the whitelist above pins to a closed union.
 */
export interface GuardArgs {
  readonly context: { readonly auth: { readonly status: GuardSessionStatus } };
  readonly location: { readonly href: string };
}
