/**
 * The only source of "now" available to `domain` and `application`.
 *
 * `Date.now()` inside a use-case makes every assertion about time either flaky or untestable, so
 * the rule is absolute (rules/hexagonal-backend.mdc, rule 2): time is an injected dependency, and
 * the adapter that calls the platform clock lives in `infrastructure`.
 */
export interface ClockPort {
  now(): Date;
}
