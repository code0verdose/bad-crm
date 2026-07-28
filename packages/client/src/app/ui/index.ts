/**
 * The handful of components the composition root owns: the boundaries every route falls back to,
 * and the layout that wraps the authenticated branch. Everything else that renders lives in
 * `pages`, `widgets` or `units` — `app` composes, it does not draw.
 */
export * from './authenticated-layout.component.js';
export * from './route-error.component.js';
export * from './route-not-found.component.js';
export * from './root-layout.component.js';
export * from './route-pending.component.js';
