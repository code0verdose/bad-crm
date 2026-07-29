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
 *
 * **The pattern is anchored at both ends, and the right-hand anchor is the load-bearing one.** `.`
 * matches everything except a line terminator, so the previous body — a bare `.` repeated, with no
 * closing `$` — matched `"/\n//evil.example"` on its first two characters and declared the rest
 * irrelevant: a string whose second line is a protocol-relative URL, through a check whose entire
 * job is to refuse those. Nothing was exploitable through it, because the router keeps only the
 * `pathname` of a value it cannot read as absolute and the host falls off; that is precisely the
 * objection. A property this schema is supposed to guarantee was being held up by the internals of a
 * dependency, and the day those change the hole opens with no edit here.
 *
 * **The body is an allow-list rather than «anything but».** It is the characters RFC 3986 permits
 * in a path, a query and a fragment, and nothing else — so a control character, a NUL or a `U+2028`
 * fails by not being listed rather than by having been thought of. That is the difference that
 * matters: a deny-list is only as good as the last enumeration of what to deny, and this value ends
 * up in a URL, in a navigation and in a log line, each of which is a parser that may disagree with
 * the previous one about where a string ends.
 *
 * Nothing legitimate is lost. The value comes from `location.href`, which is percent-encoded, so
 * every path this application can ask to return to is already inside the list; anything outside it
 * falls back to `POST_LOGIN_PATH`, which is a worse destination rather than an error.
 */
const SAFE_INTERNAL_PATH = /^\/(?![/\\])[\w\-.~!$&'()*+,;=:@/?#%]*$/;

export const loginSearchSchema = z.object({
  redirect: z.string().regex(SAFE_INTERNAL_PATH).optional().catch(undefined),
});

export type LoginSearch = z.infer<typeof loginSearchSchema>;
