/** The two things one can do to an invitation that already exists. */
export type InvitationActionKind = 'resend' | 'revoke';

export interface InvitationActionCopy {
  readonly titleKey: string;
  readonly descriptionKey: string;
  /** What will be true afterwards — listed **before** the button, not reported after it. */
  readonly consequenceKeys: readonly string[];
  readonly confirmKey: string;
  readonly failedTitleKey: string;
  /** Whether the confirming button is drawn as destructive. Revoking deletes a row; re-issuing does
   * not, but it does kill a link somebody may already have been sent. */
  readonly isDestructive: boolean;
}

/**
 * One confirmation dialog serves both actions, so the sentences live here rather than in it.
 *
 * **Keys, never text** (`rules/i18n.mdc` §5), and written out rather than assembled: a key composed
 * as `members.invitations.${action}.title` is invisible to `pnpm i18n:check`, which reads literals,
 * so a catalogue missing half of these would pass every gate in the repository and render its own
 * key at an administrator.
 */
export const INVITATION_ACTION_COPY: Readonly<Record<InvitationActionKind, InvitationActionCopy>> =
  {
    resend: {
      titleKey: 'members.invitations.resend.title',
      descriptionKey: 'members.invitations.resend.description',
      consequenceKeys: [
        'members.invitations.resend.consequence.oldLink',
        'members.invitations.resend.consequence.expiry',
        'members.invitations.resend.consequence.once',
      ],
      confirmKey: 'members.invitations.resend.confirm',
      failedTitleKey: 'members.invitations.resend.failed',
      isDestructive: false,
    },
    revoke: {
      titleKey: 'members.invitations.revoke.title',
      descriptionKey: 'members.invitations.revoke.description',
      consequenceKeys: [
        'members.invitations.revoke.consequence.link',
        'members.invitations.revoke.consequence.person',
        'members.invitations.revoke.consequence.permanent',
      ],
      confirmKey: 'members.invitations.revoke.confirm',
      failedTitleKey: 'members.invitations.revoke.failed',
      isDestructive: true,
    },
  };
