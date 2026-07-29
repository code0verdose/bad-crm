/**
 * What the sign-in form says when the answer was a choice rather than a session.
 *
 * An address used in more than one organization on this installation gets
 * `organization_selection_required` and the list to pick from; the picker itself is STORY-006-01's
 * screen. Until it exists, the honest thing is to say so where the person is looking — inline,
 * above the fields — rather than to sign them into an organization nobody chose.
 *
 * A key, not a sentence: the catalogue lands with EPIC-008 and the substitution is mechanical
 * (`rules/i18n.mdc` §1).
 */
export const ORGANIZATION_SELECTION_NOTICE_KEY = 'auth.login.organizationSelectionRequired';
