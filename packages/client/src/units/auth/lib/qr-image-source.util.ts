/**
 * The QR code the server drew, as something an `<img>` can show.
 *
 * **Why not the obvious thing.** `POST /auth/2fa/setup` answers with an inline SVG *document*, and
 * the direct way to put a document on screen is `dangerouslySetInnerHTML`. In this application that
 * does not merely offend a lint rule — it throws. The page runs under
 * `require-trusted-types-for 'script'` with a single `default` policy that **rejects any string
 * containing an angle bracket** (`app/trusted-types.util.ts`, ADR-0023), so assigning markup as
 * HTML is a `TypeError` in a real browser while remaining perfectly green in jsdom, which has no
 * Trusted Types at all. A QR code that works in the test suite and blanks the enrolment screen in
 * Chrome is the worst available outcome.
 *
 * An `<img>` is also the smaller surface on its own terms: the server's SVG is data from the
 * network, and inside `innerHTML` a document is executable; inside `img` it is a picture. The CSP
 * allows the source — `img-src 'self' data: blob:` — so nothing has to be widened for it.
 *
 * `encodeURIComponent` rather than `btoa`: base64 in a browser is Latin-1 only and throws on the
 * first character above U+00FF. The SVG is ASCII today, and «today» is not a property of somebody
 * else's renderer.
 *
 * This URI carries the secret, and that is not a leak: it is the `src` of an image, never a
 * navigation. Nothing puts it in the address bar, the history or a request — the one place that
 * would happen is `location.href = …`, which is exactly what `download-recovery-codes.util.ts`
 * refuses to do for the same reason.
 */
export const qrImageSource = (svg: string): string =>
  `data:image/svg+xml,${encodeURIComponent(svg)}`;
