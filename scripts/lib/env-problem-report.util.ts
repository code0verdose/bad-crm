import type { EnvResolution } from './check-env.util.js';

/**
 * What to print when the configuration itself is the problem — before a single socket is opened.
 *
 * Both entry points share this text because both failures are the same failure at different times:
 * a contributor who has not yet copied the template, and an installation whose `.env` drifted from
 * the schema. In either case connecting somewhere would only produce a second, less useful error.
 */

export const MISSING_ENV_FILE_LINES = (envFilePath: string): string[] => [
  `  ${envFilePath} does not exist.`,
  '',
  '  Create it from the template and generate the two secrets that have no usable placeholder:',
  '',
  '    cp .env.example .env',
  '    openssl rand -base64 32     # APP_ENCRYPTION_KEY — exactly 32 bytes, base64',
  '    openssl rand -base64 48     # JWT_SECRET — at least 32 characters',
  '',
  '  Then start the services: pnpm docker:up',
];

export const INVALID_ENV_LINES = (resolution: EnvResolution): string[] => [
  `  ${resolution.envFilePath} is invalid (${resolution.issues.length} problem(s)):`,
  '',
  ...resolution.issues.map((issue) => `    - ${issue.variable}: ${issue.message}`),
  '',
  '  The list above comes from the same schema the server parses at boot',
  '  (packages/server/src/infrastructure/bootstrap/env.schema.ts); see .env.example for the',
  '  documented value of every variable.',
];
