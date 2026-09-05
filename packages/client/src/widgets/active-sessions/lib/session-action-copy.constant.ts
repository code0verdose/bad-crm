/**
 * The three things one can ask this screen to close.
 *
 * `revoke` and `signOut` hit the same endpoint and differ only in which row they name — but they are
 * different questions to the person answering them, and that is what a confirmation is for: one
 * closes a device somebody else is holding, the other ends the session reading the dialog.
 */
export type SessionActionKind = 'revoke' | 'signOut' | 'others';

export interface SessionActionCopy {
  readonly titleKey: string;
  readonly descriptionKey: string;
  /** What will be true afterwards, listed **before** the button rather than reported after it. */
  readonly consequenceKeys: readonly string[];
  readonly confirmKey: string;
}

/**
 * Keys, never text (`rules/i18n.mdc` §5) — the component translates.
 *
 * The three consequence lists overlap on purpose and are assembled from shared sentences rather than
 * written out three times: «it stops working within a second» is the same fact about all three, and
 * three copies of it are three chances for one of them to be reworded and drift.
 *
 * What differs is the third line. Closing somebody else's device and closing every other device both
 * end with «there is no undoing this»; closing *this* session ends with what happens to this tab,
 * because that is the part somebody is about to be surprised by.
 */
export const SESSION_ACTION_COPY: Readonly<Record<SessionActionKind, SessionActionCopy>> = {
  revoke: {
    titleKey: 'security.sessions.dialog.revoke.title',
    descriptionKey: 'security.sessions.dialog.revoke.description',
    consequenceKeys: [
      'security.sessions.consequence.immediate',
      'security.sessions.consequence.signInAgain',
      'security.sessions.consequence.noUndo',
    ],
    confirmKey: 'security.sessions.dialog.revoke.confirm',
  },
  signOut: {
    titleKey: 'security.sessions.dialog.signOut.title',
    descriptionKey: 'security.sessions.dialog.signOut.description',
    consequenceKeys: [
      'security.sessions.consequence.here',
      'security.sessions.consequence.signInAgain',
      'security.sessions.consequence.noUndo',
    ],
    confirmKey: 'security.sessions.dialog.signOut.confirm',
  },
  others: {
    titleKey: 'security.sessions.dialog.others.title',
    descriptionKey: 'security.sessions.dialog.others.description',
    consequenceKeys: [
      'security.sessions.consequence.immediate',
      'security.sessions.consequence.signInAgain',
      'security.sessions.consequence.noUndo',
    ],
    confirmKey: 'security.sessions.dialog.others.confirm',
  },
};
