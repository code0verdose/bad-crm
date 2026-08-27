/**
 * @vitest-environment node
 *
 * Who is allowed to put something in the operating system's clipboard.
 *
 * The register exists because the handler that does it is **policy, not plumbing**, and policy
 * written twice drifts. It was written twice: `widgets/invite-member` and `widgets/invitation-list`
 * each carried the same `navigator.clipboard.writeText(url).then(ok, fail)`, the same notification
 * id `invitation-link-copied`, the same pair of keys and the same paragraph of comment in different
 * words — and both were feeding the same component, `IamUi.InvitationLink`, which already owned the
 * button. Two copies of a rule about a credential shown exactly once is two places to forget the
 * rejection branch, and the rejection branch is the whole point: a person who believes they copied
 * an invitation link and did not has lost the only copy that will ever exist.
 *
 * So the tree is asserted rather than remembered. A third caller — the vault's «copy the secret»,
 * which owes a countdown and an automatic wipe (`rules/e2ee-crypto.mdc`) — fails here on the day it
 * lands, which is the day somebody has to decide whether it shares this policy or needs its own.
 * That is a decision worth being asked for, not one worth discovering later.
 *
 * **What this cannot do** is judge the handler. It matches the call, not the branches; the proof
 * that a refused clipboard is announced lives in `test/routes/invite-screen.test.tsx` and
 * `test/widgets/invitation-list.test.tsx`, which press the button on the real screen.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

const sourceFiles = (directory: string = SRC): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;

    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.tsx?$/.test(entry.name) || entry.name.endsWith('.d.ts')) return [];

    return [path];
  });

/**
 * Comments are stripped before matching, for the reason the ad-hoc-key detector beside this file
 * gives: the module that owns the clipboard names it in the prose explaining why it is the only
 * one, and a register that its own owner's explanation cannot survive is unexplainable.
 */
const codeOf = (path: string): string =>
  readFileSync(path, 'utf8')
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .replaceAll(/\/\/.*$/gm, '');

/** The write, not the object: reading the clipboard is a different question with a different answer. */
const CLIPBOARD_WRITE = /navigator\s*\.\s*clipboard/;

/**
 * The one module that may hand something to the clipboard, and it is a hook rather than a
 * component: the pair of signals it emits is the unit's decision about its own credential, and
 * `ui` asks for it the way it asks for everything else (`rules/frontend-fsd.mdc` rule 6).
 */
const OWNERS = ['units/iam/service/hooks/use-copy-invitation-link.hook.ts'];

describe('the clipboard write detector', () => {
  it.each([
    ['a direct write', 'void navigator.clipboard.writeText(url);'],
    ['a spaced write', 'await navigator . clipboard . writeText(url)'],
  ])('recognises %s', (_case, source) => {
    expect(CLIPBOARD_WRITE.test(source)).toBe(true);
  });

  it('does not fire on a name that merely contains it', () => {
    expect(CLIPBOARD_WRITE.test('const clipboardHint = t("members.invite.copy");')).toBe(false);
  });
});

describe('the client tree', () => {
  it('CONTROL: the walk reads the source tree it is asserting about', () => {
    // Without this a rename that moved `src/` would make the assertion below vacuously true and the
    // register would be gone with nothing turning red.
    expect(sourceFiles().length).toBeGreaterThan(50);
  });

  it('writes to the clipboard from exactly the modules that own that policy', () => {
    const offenders = sourceFiles()
      .filter((path) => CLIPBOARD_WRITE.test(codeOf(path)))
      .map((path) => path.slice(SRC.length + 1))
      .sort();

    expect(
      offenders,
      'the copy handler belongs to the component that owns the button, once — not to each caller',
    ).toEqual([...OWNERS].sort());
  });
});
