import type { z } from 'zod';

export interface EnvIssue {
  /** Name of the offending variable, or `<root>` for a rule that spans several. */
  readonly variable: string;
  readonly message: string;
}

export const toEnvIssues = (error: z.ZodError): EnvIssue[] =>
  error.issues.map((issue) => ({
    variable: issue.path.length > 0 ? issue.path.join('.') : '<root>',
    message: issue.message,
  }));

/**
 * Startup configuration failure.
 *
 * Carries **every** invalid variable, not the first one: the message is the only thing an operator
 * of a self-hosted installation gets, and it has to be a complete to-do list. Values are never
 * included — half of these variables are secrets, and a fatal log line ends up in a bug report.
 */
export class EnvValidationError extends Error {
  readonly issues: readonly EnvIssue[];

  constructor(issues: readonly EnvIssue[]) {
    super(
      [
        `Invalid environment configuration (${issues.length} problem(s)):`,
        ...issues.map((issue) => `  - ${issue.variable}: ${issue.message}`),
        'See .env.example for the full list of variables and docs/runbooks/install.md for the setup steps.',
      ].join('\n'),
    );

    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}
