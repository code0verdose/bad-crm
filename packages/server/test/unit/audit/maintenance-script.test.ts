import { describe, expect, it } from 'vitest';

import { ownerRoleHint, readScriptEnv } from '../../../scripts/maintenance-script.util.js';

/**
 * The two things every maintenance command does before and after its work, and both used to be
 * wrong in the same way: a configuration error escaped the `try` as a stack trace with exit code
 * `1` — which the runbook reads as «something was refused» — and a run under the wrong role said
 * `must be owner of table audit_logs` and nothing about which variable would fix it.
 */

const VALID_ENCRYPTION_KEY = `${'A'.repeat(43)}=`;

const VALID_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  APP_URL: 'https://crm.example.com',
  DATABASE_URL: 'postgres://app_user:secret@localhost:5432/bad_crm',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'j'.repeat(32),
  APP_ENCRYPTION_KEY: VALID_ENCRYPTION_KEY,
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'bad-crm',
  S3_ACCESS_KEY: 'access-key',
  S3_SECRET_KEY: 'secret-key',
};

describe('reading the environment of a maintenance command', () => {
  it('returns the parsed environment when it is valid', () => {
    const result = readScriptEnv('db:audit-retention', VALID_ENV);

    expect(result.ok).toBe(true);
    expect(result.ok && result.env.AUDIT_RETENTION_MONTHS).toBeUndefined();
  });

  it('turns a configuration error into a message naming the command and the variable — no stack', () => {
    const result = readScriptEnv('db:audit-retention', {
      ...VALID_ENV,
      AUDIT_RETENTION_MONTHS: '6',
    });

    expect(result.ok).toBe(false);

    const message = result.ok ? '' : result.message;

    expect(message).toMatch(/^db:audit-retention could not run: /);
    expect(message).toContain('AUDIT_RETENTION_MONTHS');
    expect(message).not.toMatch(/\n\s+at /);
  });
});

describe('the hint about the role', () => {
  const mustBeOwner = Object.assign(new Error('must be owner of table audit_logs'), {
    code: '42501',
  });

  it('names DATABASE_MIGRATION_URL when the command ran without it and PostgreSQL wanted the owner', () => {
    expect(ownerRoleHint(mustBeOwner, { migrationUrlSet: false })).toBe(
      'hint: set DATABASE_MIGRATION_URL (app_migrator) — this command runs DDL the application role does not own',
    );
  });

  it('says nothing when the migration URL was set: the role is not the problem then', () => {
    expect(ownerRoleHint(mustBeOwner, { migrationUrlSet: true })).toBeUndefined();
  });

  it('says nothing about any other failure', () => {
    expect(
      ownerRoleHint(new Error('connection refused'), { migrationUrlSet: false }),
    ).toBeUndefined();
    expect(ownerRoleHint('not even an error', { migrationUrlSet: false })).toBeUndefined();
  });
});
