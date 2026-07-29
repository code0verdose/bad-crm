import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';

import { createRoutes } from '@/presentation/http/api.routes.js';
import { contentSecurityPolicyDirectives } from '@/presentation/http/content-security-policy.util.js';
import { allowedOrigins, isOriginAllowed } from '@/presentation/http/cors-origin.util.js';
import { createErrorHandler } from '@/presentation/http/error-handler.middleware.js';
import { type HttpServerDependencies } from '@/presentation/http/http-server.types.js';
import { createNotFoundMiddleware } from '@/presentation/http/middleware/not-found.middleware.js';
import { createRequestContextMiddleware } from '@/presentation/http/middleware/request-context.middleware.js';

/**
 * Bodies are capped at 1 MB: files never travel through Node — the browser uploads them straight to
 * S3 over a presigned URL (ADR-0015, rules/security.mdc rule 14). Anything larger is a defect or an
 * attack, and it is refused by the parser before a handler allocates anything.
 */
const BODY_LIMIT = '1mb';

/** One year, the value HSTS preload lists require; only sent when `APP_URL` is https. */
const HSTS_MAX_AGE_SECONDS = 31_536_000;

/**
 * The Express application, assembled from ports and use-cases — no listener, no signal handlers.
 *
 * Keeping `listen` out of this function is what makes the whole HTTP surface testable in-process
 * with supertest, and it is why the composition root can start the same application object it
 * later shuts down.
 *
 * The order of the middleware chain is a contract, not a preference:
 *
 * 1. **request context** — everything after it logs the `requestId` it establishes;
 * 2. **completion logging** — mounted early so a request rejected by a later layer is still logged;
 * 3. **helmet, then CORS** — security headers apply to error responses too;
 * 4. **body parsing** — after the headers are decided, before any route;
 * 5. **routes**;
 * 6. **not-found**, then the **error handler last** — an error middleware only catches what was
 *    registered before it, which is why nothing may be appended after this function returns.
 */
export const createHttpServer = (dependencies: HttpServerDependencies): Express => {
  const app = express();
  const origins = allowedOrigins({
    appUrl: dependencies.config.appUrl,
    extraOrigins: dependencies.config.corsExtraOrigins,
  });

  app.disable('x-powered-by');
  /**
   * Whose word to take for the caller's address, from configuration and never from a constant.
   *
   * `X-Forwarded-For` is a request header, so it is evidence only where a proxy the operator runs
   * has appended the real peer. `true` would trust the whole chain — any client could then name its
   * own address — and a hard-coded `1` is the same mistake wherever no proxy exists, which is what
   * the shipped `docker-compose.yml` describes: Caddy, nginx or Traefik is installed by the
   * operator (`docs/runbooks/install.md` §3). The number of hops is therefore theirs to state, and
   * `TRUSTED_PROXY_HOPS` defaults to `0`: believe the socket.
   *
   * What rides on it: `sessions.ip_hash` and `sessions.ip_masked`, which the account owner reads on
   * `/settings/security` and an incident investigation reads afterwards, and the key the rate
   * limiter counts a sign-in attempt against — one forged header per request would otherwise be a
   * fresh budget per request.
   */
  app.set('trust proxy', dependencies.config.trustedProxyHops);

  app.use(
    createRequestContextMiddleware({
      requestContext: dependencies.requestContext,
      idGenerator: dependencies.idGenerator,
    }),
  );
  app.use(dependencies.httpLogger);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: contentSecurityPolicyDirectives({
          storageEndpoint: dependencies.config.storageEndpoint,
        }),
      },
      // ADR-0023: `require-corp` demands `Cross-Origin-Resource-Policy` from every cross-origin
      // resource. MinIO does not send it, so the policy would silently blank out every presigned
      // image. It buys cross-origin isolation, which this product has no use for; the XS-Leak
      // protection comes from COOP below, which stays.
      crossOriginEmbedderPolicy: false,
      crossOriginOpenerPolicy: { policy: 'same-origin' },
      // `no-referrer`, not helmet's `strict-origin-when-cross-origin`, and the difference is a live
      // credential. `strict-origin-when-cross-origin` sends the origin, path *and* query string on
      // a same-origin request — so a document at `/reset-password/<token>` puts that token in the
      // `Referer` of every asset it loads and of the reset call itself. The operator supplies their
      // own reverse proxy (`docs/runbooks/install.md`), and nginx's stock `combined` format logs
      // `$http_referer`: an unspent token reaches an access log, which is enough to take the
      // account over. `docs/security/threat-model.md` T-IAM-07 names this header for exactly that.
      //
      // Global rather than per-route: the SPA is one `index.html` for every path, so there is no
      // per-route document to attach a response header to. Nothing here consumes a referrer.
      referrerPolicy: { policy: 'no-referrer' },
      // Helmet's default is SAMEORIGIN, which contradicts `frame-ancestors 'none'` in the CSP. The
      // two headers are read by different browsers — a legacy one obeys X-Frame-Options and would
      // happily frame the application into another page of the same origin, which is exactly the
      // surface clickjacking needs.
      frameguard: { action: 'deny' },
      // Sent only when the installation is actually served over https. On a plain-http development
      // or LAN installation HSTS would pin the browser to a scheme the server does not answer on,
      // and the operator would have to clear it by hand.
      hsts: dependencies.config.appUrl.startsWith('https://')
        ? { maxAge: HSTS_MAX_AGE_SECONDS, includeSubDomains: true }
        : false,
    }),
  );

  app.use(
    cors({
      // A fixed allow-list. `origin: true` reflects whatever the caller sent, which together with
      // `credentials: true` lets any site the user has open call this API with their session.
      origin: (origin, callback) => callback(null, isOriginAllowed(origin ?? undefined, origins)),
      credentials: true,
    }),
  );

  app.use(express.json({ limit: BODY_LIMIT }));
  // Refresh tokens travel in an httpOnly cookie (EPIC-006); the parser is mounted here so that the
  // auth routes added later need no per-route wiring.
  app.use(cookieParser());

  app.use(createRoutes(dependencies));

  app.use(createNotFoundMiddleware());
  app.use(
    createErrorHandler({
      logger: dependencies.logger,
      requestContext: dependencies.requestContext,
    }),
  );

  return app;
};
