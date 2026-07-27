/**
 * Entry point placeholder of the web client.
 *
 * The React 19 application shell, Vite config (with the same aliases as `tsconfig.json`),
 * providers and routing land in EPIC-004. For now this file only proves that the client
 * resolves the shared package.
 */
import { SHARED_PACKAGE_NAME } from '@bad-crm/shared';

/** Wiring smoke check: the client compiles against the shared package. */
export const CLIENT_LINKED_AGAINST = SHARED_PACKAGE_NAME;
