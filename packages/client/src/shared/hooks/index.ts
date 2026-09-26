/**
 * Hooks that hold a *preference* or a piece of local UI state, and know nothing about a domain
 * (`rules/frontend-fsd.mdc` rule 8).
 *
 * Appearance lives here rather than in a `units/appearance` slice because none of it is domain
 * state: there is no entity, no request, no cache. That is still true of the colour scheme, the
 * density and the sidebar — nothing stores them server-side.
 *
 * The trigger this docstring named has passed, so it is restated (2026-08-30). It said the unit
 * would appear «when the profile starts storing these choices server-side (EPIC-012)». One of the
 * choices is already stored: `users.locale` and `users.timezone` were added by EPIC-006's migration
 * `20260728120000_auth_core_identity_and_sessions`, and `SessionUser` carries both in the contract
 * today. EPIC-012 shipped without moving these hooks, and `useLanguage` still resolves from
 * `localStorage` and the browser rather than from that answer. The move is open work, not a
 * scheduled consequence of an epic.
 */
export * from './use-color-scheme.hook.js';
export * from './use-density.hook.js';
export * from './use-focus-handoff.hook.js';
export * from './use-language.hook.js';
export * from './use-seconds-remaining.hook.js';
export * from './use-sidebar-collapse.hook.js';
