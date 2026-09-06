/**
 * Isomorphic organization-level settings.
 *
 * Only the shapes both sides need: the security policy is written by the server and rendered by the
 * administration screen, and both parse it with this one schema rather than with two that agree
 * today (`rules/zod-validation.mdc`, rule 1).
 */
export * from './security-policy.schema.js';
