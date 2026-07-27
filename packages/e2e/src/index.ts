/**
 * Placeholder entry point of the end-to-end suite.
 *
 * Playwright config, fixtures and the specs themselves land in EPIC-010. This package
 * deliberately depends on no workspace sources: it drives the running stack over HTTP and UI,
 * so it must not know the internals of the server or the client.
 */

/** Workspace name of this package; kept so the package has a typechecked entry point. */
export const E2E_PACKAGE_NAME = '@bad-crm/e2e';
