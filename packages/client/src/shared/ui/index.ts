/**
 * The design system of the client: components that know a *state* or a *policy*, never a domain
 * (`rules/frontend-fsd.mdc` rule 8, `rules/design-system.mdc` §9).
 *
 * What is deliberately absent is a wrapper around a Mantine component that adds nothing —
 * `Button`, `TextInput`, `Modal` and friends are used directly (`rules/design-system.mdc` §7). A
 * component earns a place here by fixing something: the loading/error/empty triad, the single
 * toaster, the shape of a page heading.
 */
export * from './centered-screen/index.js';
export * from './data-state/index.js';
export * from './page-header/index.js';
export * from './skeletons/index.js';
export * from './toaster/index.js';
