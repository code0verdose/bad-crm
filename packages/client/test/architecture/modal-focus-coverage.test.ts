/**
 * @vitest-environment node
 *
 * Every trap surface the client ships is named by a suite that proves the four sentences of
 * `rules/a11y.mdc` §6 about it — asserted over the tree, because the list keeps growing.
 *
 * This is the guard the eighth acceptance criterion of EPIC-007 actually needed. The criterion was
 * treated as closed by one test about one modal, and by the time anybody looked there were six more
 * surfaces: five dialogs and the navigation drawer, three of them with a forward-only tab loop, one
 * with no trap assertion at all, and one — `permission-override-dialog` — whose focus never came
 * back to the row it was opened from. None of that was visible from a coverage report, because
 * every one of those files was thoroughly executed.
 *
 * So the list is derived from the source rather than remembered. A seventh dialog added tomorrow
 * fails here on the day it lands, with the name of the file that has no owner, instead of being
 * noticed the next time somebody counts modals by hand.
 *
 * **What this cannot do** is judge whether the cases it finds are any good — it matches the helpers
 * and the key, not the assertions. It is a register of ownership, not a second opinion: the proof
 * that each of those cases goes red for the defect it names lives in the suites themselves.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));
const TEST = fileURLToPath(new URL('..', import.meta.url));

const sourceFiles = (directory: string = SRC): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;

    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.tsx$/.test(entry.name)) return [];

    return [path];
  });

/**
 * A trap surface is a rendered `Modal` or `Drawer`, found by the JSX rather than by the file name.
 *
 * The file name is what `CLAUDE.md` greps (`modal|dialog`), and it already missed one: the mobile
 * navigation is a `Drawer` inside `app-shell.widget.tsx`, which matches neither word. `rules/a11y.mdc`
 * gives §6 to modals and §7 to drawers and asks both for the same trap, so both are discovered here.
 */
const trapSurfaces = (): string[] =>
  sourceFiles()
    .filter((file) => /<(Modal|Drawer)[\s>]/.test(readFileSync(file, 'utf8')))
    .map((file) => file.slice(SRC.length + 1))
    .sort();

/**
 * Who proves what. One line per surface, and the line is the point: adding a surface without adding
 * a line fails, and so does adding a line for a surface that no longer exists.
 */
const OWNERS: Readonly<Record<string, string>> = {
  'units/auth/ui/recovery-codes-dialog.component.tsx': 'widgets/recovery-codes.test.tsx',
  'widgets/active-sessions/ui/session-confirm-dialog.component.tsx':
    'widgets/active-sessions.test.tsx',
  'widgets/app-shell/app-shell.widget.tsx': 'widgets/app-shell.test.tsx',
  'widgets/disable-totp/ui/disable-totp-dialog.component.tsx': 'widgets/disable-totp.test.tsx',
  'widgets/invitation-list/ui/invitation-confirm-dialog.component.tsx':
    'widgets/invitation-list.test.tsx',
  'widgets/offboarding/offboarding-dialog.widget.tsx': 'widgets/offboarding.test.tsx',
  'widgets/project-settings/ui/project-confirm-dialog.component.tsx':
    'routes/project-settings-screen.test.tsx',
  'widgets/reactivation/ui/reactivation-dialog.component.tsx': 'widgets/reactivation.test.tsx',
  'widgets/reset-mfa/ui/reset-mfa-dialog.component.tsx': 'widgets/reset-mfa.test.tsx',
  'widgets/role-matrix/ui/role-matrix-preview-modal.component.tsx':
    'widgets/role-matrix-preview-modal.test.tsx',
  'widgets/security-policy/ui/policy-preview-dialog.component.tsx':
    'widgets/security-policy.test.tsx',
  'widgets/team-detail/ui/team-delete-dialog.component.tsx': 'widgets/team-detail.test.tsx',
  'widgets/team-list/ui/team-create-dialog.component.tsx': 'widgets/team-list.test.tsx',
  'widgets/user-permissions/ui/permission-override-dialog.component.tsx':
    'widgets/user-permissions.test.tsx',
};

/**
 * The four sentences, as what a suite that states them has to contain.
 *
 * Three are the shared helpers, which is what makes this checkable at all: an assertion spelled out
 * by hand is the thing that drifts — five of these files had a hand-written forward-only loop, and
 * every one of them read like a trap test. The fourth is the key itself, because what a dialog does
 * with `Esc` is a per-dialog judgement (the recovery-code set refuses it until the codes are saved)
 * and cannot be shared; what can be required is that somebody decided.
 */
const REQUIRED = [
  // Matched as **calls**, with the parenthesis: a bare name is satisfied by the import line, and an
  // import is what is left behind when the case that used it is deleted. Measured — the first shape
  // of this check stayed green through exactly that deletion.
  ['focus enters the dialog', /\bexpectFocusInside\(/],
  ['focus stays in it, both ways', /\bfocusEscapes\(/],
  ['focus wraps at both ends', /\btabWrapFailures\(/],
  ['Escape is answered, one way or the other', /\{Escape\}/],
  // Three spellings, because where the focus goes is the one property that is not the same sentence
  // everywhere: two dialogs aim it themselves (the recovery-code set at the page heading), so what
  // can be required is that the suite says *something* about where the focus ended up.
  [
    'focus goes back when it closes',
    /expectFocusReturnedTo\(|toHaveFocus\(\)|document\.activeElement/,
  ],
] as const;

describe('every modal and drawer in the client', () => {
  it('CONTROL: the walk reads the source tree it is asserting about', () => {
    // Without this, a rename that moved `src/` would make every assertion below vacuously true and
    // the register would be gone with nothing turning red.
    expect(sourceFiles().length).toBeGreaterThan(50);
    expect(trapSurfaces().length).toBeGreaterThan(5);
  });

  it('is named by a suite that owns its focus behaviour', () => {
    expect(trapSurfaces()).toEqual(Object.keys(OWNERS).sort());
  });

  it.each(Object.entries(OWNERS))('%s is covered by %s', (_surface, suite) => {
    const source = readFileSync(`${TEST}/${suite}`, 'utf8');

    for (const [property, pattern] of REQUIRED) {
      expect(pattern.test(source), `${suite} states nothing about: ${property}`).toBe(true);
    }
  });
});
