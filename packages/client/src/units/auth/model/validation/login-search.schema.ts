import { z } from 'zod';

/**
 * `/login?redirect=…` — where to send the user once they are in.
 *
 * It lives in the auth unit rather than next to the route because it is a rule about sessions, not
 * about a URL shape: `rules/zod-validation.mdc` rule 11 puts domain schemas in
 * `units/<unit>/model/validation`, and the route file only names it in `validateSearch`.
 *
 * The validation here is a security control, not tidiness. `redirect` is attacker-controlled by
 * construction: the link is built by whoever sends it, the domain is this installation, the login
 * form is the real one — and the destination afterwards is wherever the parameter says. That is an
 * open redirect, the classic phishing primitive, and the mitigation is to accept **only a path on
 * this origin**.
 *
 * Rejected, therefore: an absolute URL (`https://evil.example/x`), a protocol-relative one
 * (`//evil.example`), a scheme (`javascript:`), and a backslash after the slash — browsers
 * normalise `/\evil.example` to `//evil.example`, which is the same host swap wearing a different
 * hat. Anything rejected becomes `undefined`, and the caller falls back to `POST_LOGIN_PATH`.
 */
const SAFE_INTERNAL_PATH = /^\/(?![/\\]).*/;

export const loginSearchSchema = z.object({
  redirect: z.string().regex(SAFE_INTERNAL_PATH).optional().catch(undefined),
});

export type LoginSearch = z.infer<typeof loginSearchSchema>;
