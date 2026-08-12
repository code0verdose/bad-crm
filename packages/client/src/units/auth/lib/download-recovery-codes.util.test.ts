import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';

import {
  downloadRecoveryCodes,
  recoveryCodesFileText,
  RECOVERY_CODES_FILE_NAME,
} from './download-recovery-codes.util.js';

const CODES = ['23456ABCDE', 'FGHJKMNPQR', 'STUVWXYZ23'] as const;
const HEADER = 'Recovery codes for this account.';

/**
 * Handing ten credentials to a person as a file, without letting them become part of anything the
 * browser keeps.
 *
 * The bytes and the mechanism are asserted separately because they fail separately: a file with the
 * wrong contents is useless, and a file delivered the wrong way is a leak — the one-line
 * alternative, `location.href = 'data:text/plain,' + codes`, writes all ten into the address bar and
 * into the session history, where they outlive the dialog that promised to show them once.
 */
describe('the recovery-code file', () => {
  it('carries the explanation first and then one code per line', () => {
    expect(recoveryCodesFileText(CODES, HEADER)).toBe(
      'Recovery codes for this account.\n\n23456ABCDE\nFGHJKMNPQR\nSTUVWXYZ23\n',
    );
  });

  it('separates the header from the codes, so the first code is not read as part of a sentence', () => {
    const lines = recoveryCodesFileText(CODES, HEADER).split('\n');

    expect(lines[0]).toBe(HEADER);
    expect(lines[1]).toBe('');
    expect(lines.slice(2, -1)).toEqual([...CODES]);
  });
});

describe('handing the file over', () => {
  const createObjectURL = vi.fn<(blob: Blob) => string>(() => 'blob:bad-crm/recovery');
  const revokeObjectURL = vi.fn<(url: string) => void>(() => undefined);
  const platform = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };

  let clicked: HTMLAnchorElement | undefined;
  let click: MockInstance<() => void>;

  beforeAll(() => {
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;

    /**
     * The click is intercepted rather than allowed through, and not to keep jsdom quiet: what is
     * asserted is that a **download** was triggered, and jsdom implements no downloads — left to
     * run, the anchor would be «navigated» to instead, which is exactly the behaviour this utility
     * exists to avoid and would therefore be indistinguishable from the defect.
     */
    click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      // Read from the document rather than from `this`: at the moment of the click the anchor is
      // attached, which is half of what is being asserted — a detached one is not reliably actioned.
      clicked = document.querySelector('a[download]') ?? undefined;
    });
  });

  afterAll(() => {
    URL.createObjectURL = platform.create;
    URL.revokeObjectURL = platform.revoke;
    click.mockRestore();
  });

  afterEach(() => {
    clicked = undefined;
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
    click.mockClear();
  });

  it('puts the codes in a blob and names the file after the product', async () => {
    downloadRecoveryCodes(CODES, HEADER);

    expect(clicked?.download).toBe(RECOVERY_CODES_FILE_NAME);
    expect(clicked?.getAttribute('href')).toBe('blob:bad-crm/recovery');

    const blob = createObjectURL.mock.calls[0]?.[0] as unknown as Blob;

    expect(blob.type).toBe('text/plain;charset=utf-8');
    expect(await blob.text()).toBe(recoveryCodesFileText(CODES, HEADER));
  });

  /**
   * The property the whole utility exists for, stated as an absence.
   *
   * A `data:` URL carries the codes inside itself; a `blob:` URL is an opaque handle that reveals
   * nothing and is dropped immediately after use. Both halves matter — a handle that is never
   * revoked is a live reference to ten credentials for the lifetime of the document.
   */
  it('never puts a code inside the URL, and lets the handle go', () => {
    downloadRecoveryCodes(CODES, HEADER);

    expect(clicked?.getAttribute('href')).not.toMatch(/^data:/);
    for (const code of CODES) expect(clicked?.getAttribute('href')).not.toContain(code);

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:bad-crm/recovery');
  });

  /**
   * And it leaves no trace in the document either. The anchor has to be attached for the click to be
   * actioned reliably across browsers; leaving it there would be an element in the page whose whole
   * purpose is to hand out the codes.
   */
  it('leaves no anchor behind in the document', () => {
    downloadRecoveryCodes(CODES, HEADER);

    expect(clicked?.isConnected).toBe(false);
    expect(document.querySelectorAll('a[download]')).toHaveLength(0);
  });
});
