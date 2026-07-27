/**
 * Composition root of the API process.
 *
 * Today it only proves that the toolchain works end to end: TypeScript resolves `@bad-crm/shared`
 * and the `@/*` alias, `tsx watch` restarts on change, and `tsc -b && tsc-alias` produces a
 * runnable `dist/main.js`. The Express application, env parsing, Prisma and graceful shutdown
 * land in EPIC-003.
 */
import { SHARED_PACKAGE_NAME } from '@bad-crm/shared';

import { APP_INFO } from '@/app-info.constant.js';

// Structured logging (pino) arrives with EPIC-009; the skeleton writes a single startup line.
// It is the only console call in the codebase and is replaced by the pino logger in EPIC-009,
// see rules/observability.mdc.
// eslint-disable-next-line no-console -- startup line until the pino logger lands (EPIC-009)
console.info(
  `[${APP_INFO.name}] ${APP_INFO.role} skeleton started, linked against ${SHARED_PACKAGE_NAME}`,
);
