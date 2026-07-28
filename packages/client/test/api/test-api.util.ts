/**
 * An absolute base URL for the suite, and the reason it is absolute.
 *
 * The application is configured with `/api/v1` — a same-origin path, which is what a browser wants
 * and what `VITE_API_BASE_URL` defaults to. The runner is not a browser: `Request` comes from Node
 * there and refuses a relative URL outright (`ERR_INVALID_URL`). Pinning an origin here keeps the
 * tests about the client instead of about the URL parser, and every assertion is still written
 * against the `/api/v1` path the deployment serves.
 */
export const API_BASE_URL = 'http://localhost/api/v1';
