/// <reference types="vite/client" />

/**
 * Injected by `vite.config.ts` at build time; the version a failure report names.
 *
 * `APP_VERSION` rather than Vite's conventional `__APP_VERSION__`: the naming rule of this
 * repository allows `UPPER_CASE` and rejects the underscore-wrapped form, and a convention borrowed
 * from a tool does not outrank the project's own.
 */
declare const APP_VERSION: string;
