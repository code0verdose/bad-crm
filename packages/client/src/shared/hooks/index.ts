/**
 * Hooks that hold a *preference* or a piece of local UI state, and know nothing about a domain
 * (`rules/frontend-fsd.mdc` rule 8).
 *
 * Appearance lives here rather than in a `units/appearance` slice because none of it is domain
 * state: there is no entity, no request, no cache. When the profile starts storing these choices
 * server-side (EPIC-012), the unit appears and these hooks become its `service/hooks`.
 */
export * from './use-color-scheme.hook.js';
export * from './use-density.hook.js';
export * from './use-sidebar-collapse.hook.js';
