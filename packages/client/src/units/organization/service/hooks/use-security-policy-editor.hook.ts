import { useCallback, useState } from 'react';

import { type PolicyRoleRef, type SecurityPolicy } from '@units/organization/api';
import { POLICY_ROLE_KEYS } from '@units/organization/model';
import { useUpdateSecurityPolicy } from '@units/organization/service/mutations';
import { errorMessage, type ErrorMessage, isApiError } from '@shared/api';

/** The unsaved policy: the two fields a client may set, and nothing else. */
export interface PolicyDraft {
  readonly roles: readonly PolicyRoleRef[];
  readonly graceDays: number;
}

export interface SecurityPolicyEditor {
  readonly draft: PolicyDraft;
  /**
   * The references in the draft that this screen has no checkbox for — custom roles, named by id.
   *
   * Derived here rather than in the form, because «what counts as a custom role» is a fact about the
   * domain and not about the markup (`rules/frontend-fsd.mdc` rule 10, `naming-and-structure.mdc`
   * §D): the form is a list of seven system roles, and the day a third category appears the answer
   * has to change in one place that a test can reach without rendering anything.
   */
  readonly customRoles: readonly PolicyRoleRef[];
  /** Whether the draft says anything different from what is stored. */
  readonly isDirty: boolean;
  readonly toggleRole: (role: PolicyRoleRef) => void;
  readonly setGraceDays: (days: number) => void;
  readonly discard: () => void;
  readonly isSaving: boolean;
  /**
   * The server has asked for a second confirmation because the caller is putting **themselves**
   * under a requirement they do not currently meet (acceptance 7).
   *
   * Derived from the refusal rather than kept in state, so it cannot survive the request that
   * cleared it: it is `true` exactly while the last answer was 428 `confirmation_required`.
   */
  readonly needsSelfLockoutConfirmation: boolean;
  /** A genuine refusal as a sentence — key and values — never the 428, which is not one. */
  readonly failure: ErrorMessage | undefined;
  readonly save: () => void;
}

/**
 * Editing the organization's second-factor policy, as the object a dialog and a form can render —
 * the unit's public API for `ui` (`rules/frontend-fsd.mdc` rule 6).
 *
 * **The draft is seeded once, from the policy this hook is given, and never re-synchronised.** That
 * is the whole reason it takes the stored policy as an argument instead of reading the query itself:
 * a hook that copied server state into local state whenever the query answered would need the
 * derived-state effect rule 11 forbids, and would throw away half-typed edits every time the
 * thirty-second staleness elapsed. The screen mounts this only once the policy has loaded, so there
 * is no «not yet known» draft to represent.
 *
 * **The 428 is not a failure and is not shown as one.** `confirmation_required` is the second half
 * of a save the server is willing to perform: it means «you are about to require a second factor of
 * yourself and you have none». The dialog renders the warning and offers the repeat;
 * `failure` stays `undefined`, so nothing red appears for a decision that is still being made.
 *
 * `onSaved` is a callback rather than an observed flag, so the dialog closes **from the mutation's
 * own success** rather than from an effect watching `isSuccess` — the reaction-to-an-event case of
 * rule 11.
 */
export const useSecurityPolicyEditor = (
  stored: SecurityPolicy,
  onSaved: () => void,
): SecurityPolicyEditor => {
  const [draft, setDraft] = useState<PolicyDraft>({
    roles: stored.mfaRequiredForRoles,
    graceDays: stored.mfaGracePeriodDays,
  });
  const mutation = useUpdateSecurityPolicy();

  /**
   * Forgets the last answer whenever the draft moves.
   *
   * Both halves of that answer belong to the draft that produced them: `needsSelfLockoutConfirmation`
   * is the server's «you are covering yourself» about **those** roles, and carrying it to the next
   * draft would send `confirmedSelfLockout: true` for a policy the server never examined — the second
   * signal of acceptance 7, handed out in advance. The refusal text is the same story: a red sentence
   * about a request the current draft has nothing to do with.
   */
  const changeDraft = useCallback(
    (change: (previous: PolicyDraft) => PolicyDraft): void => {
      mutation.reset();
      setDraft(change);
    },
    [mutation],
  );

  const toggleRole = useCallback(
    (role: PolicyRoleRef): void => {
      changeDraft((previous) => ({
        ...previous,
        // In or out, and never twice in: the policy refuses a duplicate, because two entries for one
        // role would give that role two start dates.
        roles: previous.roles.includes(role)
          ? previous.roles.filter((entry) => entry !== role)
          : [...previous.roles, role],
      }));
    },
    [changeDraft],
  );

  const setGraceDays = useCallback(
    (days: number): void => {
      changeDraft((previous) => ({ ...previous, graceDays: days }));
    },
    [changeDraft],
  );

  const discard = useCallback((): void => {
    setDraft({ roles: stored.mfaRequiredForRoles, graceDays: stored.mfaGracePeriodDays });
    mutation.reset();
  }, [mutation, stored.mfaGracePeriodDays, stored.mfaRequiredForRoles]);

  const needsSelfLockoutConfirmation =
    mutation.error !== null &&
    isApiError(mutation.error) &&
    mutation.error.code === 'confirmation_required';

  const save = useCallback((): void => {
    mutation.mutate(
      {
        mfaRequiredForRoles: [...draft.roles],
        mfaGracePeriodDays: draft.graceDays,
        // Sent only on the repeat of a request the server refused with 428, which is what the
        // contract asks for — a client that always sent it would have removed the safeguard.
        ...(needsSelfLockoutConfirmation ? { confirmedSelfLockout: true } : {}),
      },
      { onSuccess: onSaved },
    );
  }, [draft.graceDays, draft.roles, mutation, needsSelfLockoutConfirmation, onSaved]);

  const systemRoles: readonly string[] = POLICY_ROLE_KEYS;

  return {
    draft,
    customRoles: draft.roles.filter((role) => !systemRoles.includes(role)),
    isDirty:
      draft.graceDays !== stored.mfaGracePeriodDays ||
      draft.roles.length !== stored.mfaRequiredForRoles.length ||
      draft.roles.some((role) => !stored.mfaRequiredForRoles.includes(role)),
    toggleRole,
    setGraceDays,
    discard,
    isSaving: mutation.isPending,
    needsSelfLockoutConfirmation,
    failure:
      mutation.error === null || needsSelfLockoutConfirmation
        ? undefined
        : errorMessage(mutation.error),
    save,
  };
};
