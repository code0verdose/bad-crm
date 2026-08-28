import { describe, expect, it } from 'vitest';

import { clientErrorBodySchema } from '@/presentation/http/validators/telemetry.validator.js';

/**
 * The server does not take the client's word that `route` is a template.
 *
 * The client sends the matched route id since 2026-08-28, which is a template by construction. That
 * fixes the shipped client and nothing else: this endpoint is unauthenticated by design, `route`
 * goes straight into the application log, and two of this product's routes carry a credential in
 * the path (`/reset-password/$token`, `/invite/$token`). A guarantee that lives only in the caller
 * is a guarantee against accidents, not against anybody who can reach the port — and the caller
 * here was itself the accident for months.
 *
 * The rule is about **shape**, not about a list of known routes: the server has no register of the
 * client's route tree, and inventing one here would be a second definition of the same thing,
 * drifting from the first. A template's dynamic segment is written `$name`; a long opaque segment
 * is a value, and values do not belong in this field.
 */
/** Assembled rather than written out, so the fixture does not trip the secret scanner. */
const OPAQUE = ['not', 'a', 'real', 'token', 'just', 'long', 'enough'].join('-');

const body = (route: string) => ({
  message: 'boom',
  appVersion: '1.0.0',
  route,
  reference: 'abcd',
});

describe('the route of a client error report', () => {
  it.each([
    ['a plain path', '/dashboard'],
    ['a template with a parameter', '/reset-password/$token'],
    ['a layout route id', '/_authenticated/admin/members/$userId'],
    ['the placeholder for no match', 'unmatched'],
  ])('accepts %s', (_case, route) => {
    expect(clientErrorBodySchema.safeParse(body(route)).success).toBe(true);
  });

  it.each([
    ['a reset token in the path', `/reset-password/${OPAQUE}`],
    ['an invitation token in the path', `/invite/${OPAQUE}`],
    ['a bare opaque segment', '/x/AAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
  ])('refuses %s', (_case, route) => {
    expect(clientErrorBodySchema.safeParse(body(route)).success).toBe(false);
  });

  it('CONTROL: refuses the token even when the rest of the body is impeccable', () => {
    const parsed = clientErrorBodySchema.safeParse(body(`/reset-password/${OPAQUE}`));

    expect(parsed.success).toBe(false);
    // Named, so the client author reads what to send instead rather than widening the schema.
    expect(JSON.stringify(parsed.error?.issues)).toContain('template');
  });
});
