import { useCallback } from 'react';

import { notify } from '@shared/ui';

/** One id, so copying twice updates the notification instead of stacking two (§2, §6). */
const NOTIFICATION_ID = 'invitation-link-copied';

/**
 * Putting an invitation link in the clipboard, and saying whether it went.
 *
 * **The rejection branch is the reason this is a named thing rather than a lambda.** The clipboard
 * is refused often enough to matter — permission denied, an insecure origin, a browser wanting a
 * fresher gesture — and on this screen silence is the worst answer available: the link is shown
 * **once**, the server keeps only a digest, and somebody who believes they copied it and did not
 * has lost the only copy that will ever exist. The first version of this handler was
 * `void … .then(onlySuccess)`, which satisfied the linter and dropped the rejection into the global
 * handler where nobody sees it.
 *
 * **It lives here because it was written twice.** `widgets/invite-member` and
 * `widgets/invitation-list` each carried it, identically, and each passed it down to the same
 * component — `IamUi.InvitationLink`, which owns the button. Two copies of one product rule is one
 * copy that will be updated and one that will not; `test/architecture/clipboard-ownership.test.ts`
 * asserts over the tree that there is only ever one.
 *
 * A hook rather than a plain function, because it is what `ui` asks the unit for, the way `ui` asks
 * for everything else (`rules/frontend-fsd.mdc` rule 6) — and because the identity it hands back is
 * stable, so the panel's button is not a new prop on every paint.
 */
export const useCopyInvitationLink = (): ((url: string) => void) =>
  useCallback((url: string) => {
    void navigator.clipboard.writeText(url).then(
      () => {
        notify.success({ id: NOTIFICATION_ID, messageKey: 'members.invite.copied' });
      },
      () => {
        notify.error({ id: NOTIFICATION_ID, messageKey: 'members.invite.copyFailed' });
      },
    );
  }, []);
