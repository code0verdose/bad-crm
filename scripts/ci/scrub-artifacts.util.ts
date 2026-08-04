/**
 * What may leave a build, decided over data rather than over a directory.
 *
 * The end-to-end run uploads traces, screenshots, videos and an HTML report to a place anybody who
 * can read the build can read. Two things must never make that trip, and they are different in kind:
 *
 *   * **a saved session or an environment file** — no evidential value, pure credential. Deleted.
 *   * **a trace that happens to contain a session cookie** — the evidence itself. Playwright records
 *     the responses it saw, and one of them is the sign-in; a trace of an authenticated scenario
 *     *will* carry a cookie, and no care in the suite changes that. It is named, never rewritten:
 *     a trace edited by a script is a trace nobody can trust afterwards.
 *
 * The filesystem lives in `scrub-e2e-artifacts.ts`; everything decided lives here, so it is testable
 * without a directory (the shape `cruft-scan.util.ts` already uses).
 */

/** Files whose name alone condemns them. */
const CONDEMNED_NAMES = [/^storage-state.*\.json$/i, /\.session\.json$/i, /^\.env($|\.)/i];

/** The cookie this installation issues. Its presence in an artifact is a credential in an artifact. */
const SESSION_COOKIE = /bad_crm_refresh/;

export interface ArtifactFile {
  /** Path as it will be reported — repository- or bundle-relative, not absolute. */
  readonly path: string;
  /** Text contents, when the file is text and small enough to scan; `undefined` for the rest. */
  readonly contents?: string;
}

export interface ScrubVerdict {
  /** Files to delete before uploading. */
  readonly remove: readonly string[];
  /** Files that carry a session cookie and are left as they are. */
  readonly carriesCookie: readonly string[];
}

export const classifyArtifacts = (files: readonly ArtifactFile[]): ScrubVerdict => {
  const remove: string[] = [];
  const carriesCookie: string[] = [];

  for (const file of files) {
    const name = file.path.split('/').pop() ?? '';

    if (CONDEMNED_NAMES.some((pattern) => pattern.test(name))) {
      remove.push(file.path);
      continue;
    }

    if (file.contents !== undefined && SESSION_COOKIE.test(file.contents)) {
      carriesCookie.push(file.path);
    }
  }

  return { remove, carriesCookie };
};

/**
 * Whether the bundle may be published.
 *
 * `ephemeral` is an assertion the caller makes about the installation the artifacts came from: it
 * was created and destroyed inside this run, so the cookie in that trace authenticates nothing by
 * the time anybody downloads it. Defaulting to it would make the check quiet exactly where it should
 * not be; defaulting to refusal would fail every CI upload over a cookie that expired with the
 * container. So it is said out loud, in the workflow, once.
 */
export const exitCodeOf = (verdict: ScrubVerdict, ephemeral: boolean): number =>
  verdict.carriesCookie.length > 0 && !ephemeral ? 1 : 0;

export const renderScrubReport = (
  verdict: ScrubVerdict,
  ephemeral: boolean,
): { readonly out: string; readonly err: string } => {
  const removed = verdict.remove.map((path) => `scrub: removed ${path}`);

  if (verdict.carriesCookie.length === 0) {
    return {
      out: [...removed, `scrub: clean (${String(verdict.remove.length)} removed)`].join('\n'),
      err: '',
    };
  }

  const named = [
    `scrub: ${String(verdict.carriesCookie.length)} artifact(s) contain a session cookie:`,
    ...verdict.carriesCookie.map((path) => `  ${path}`),
  ];

  return ephemeral
    ? {
        out: [
          ...removed,
          ...named,
          'Published anyway: --ephemeral says this installation dies with the run.',
        ].join('\n'),
        err: '',
      }
    : {
        out: removed.join('\n'),
        err: [
          ...named,
          'Refusing to publish. Rewriting them would produce a trace nobody can trust — pass',
          '--ephemeral only when the installation is created and destroyed inside this run.',
        ].join('\n'),
      };
};
