/** What the browser calls the file it saves. Named after the product, not after the account. */
export const RECOVERY_CODES_FILE_NAME = 'bad-crm-recovery-codes.txt';

/**
 * The file's contents: a line of explanation the reader will need in six months, then one code per
 * line so that a text file is also a list somebody can tick off.
 *
 * A pure function, separately exported, because it is the half worth asserting: the effect below
 * cannot be observed in jsdom without stubbing three platform APIs, and the bytes can.
 */
export const recoveryCodesFileText = (codes: readonly string[], header: string): string =>
  `${header}\n\n${codes.join('\n')}\n`;

/**
 * Hands the ten codes over as a `.txt`, without letting them become part of anything that is kept.
 *
 * **The mechanism is the point.** The one-line way to do this is
 * `location.href = 'data:text/plain,' + codes` — and that writes the ten codes into the address bar,
 * into the session history, into whatever the browser syncs, and into the next screenshot somebody
 * takes of their browser. A `blob:` URL is an opaque handle instead: the bytes live in memory, the
 * URL names them and reveals nothing, the anchor's `download` attribute means the navigation never
 * happens at all, and `revokeObjectURL` drops the handle immediately afterwards.
 *
 * The anchor is attached and removed rather than clicked detached, because a detached anchor is not
 * reliably actioned across browsers — and attaching it costs nothing here: the element carries the
 * opaque handle, never a code.
 */
export const downloadRecoveryCodes = (codes: readonly string[], header: string): void => {
  const blob = new Blob([recoveryCodesFileText(codes, header)], {
    type: 'text/plain;charset=utf-8',
  });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');

  anchor.href = href;
  anchor.download = RECOVERY_CODES_FILE_NAME;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(href);
};
