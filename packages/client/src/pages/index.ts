/**
 * Pages are components, not segmented slices, so this barrel re-exports them by name rather than
 * as namespaces: `import { DashboardPage } from '@pages'`. Which URL mounts which page is decided
 * by the route files in `app/routes/**`, never here.
 */
export * from './dashboard/index.js';
export * from './forgot-password/index.js';
export * from './login/index.js';
export * from './reset-password/index.js';
export * from './admin-roles/index.js';
export * from './admin-members-invite/index.js';
export * from './accept-invite/index.js';
export * from './employee-profile/index.js';
export * from './settings-security/index.js';
export * from './admin-teams/index.js';
export * from './team-detail/index.js';
