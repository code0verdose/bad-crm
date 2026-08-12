import { errorMessageKey } from '@shared/api';
import { type TotpEnrolmentDraft } from '@units/auth/api';
import { type TotpConfirmFormValues } from '@units/auth/model';
import { useConfirmTotp } from '@units/auth/service/mutations/confirm-totp.mutation.js';
import { useSetupTotp } from '@units/auth/service/mutations/setup-totp.mutation.js';

export interface TotpEnrolment {
  /** The drafted secret, its URI and its QR — present only between «Enable» and «Confirm». */
  readonly draft: TotpEnrolmentDraft | undefined;
  /** The ten codes, for as long as the person is looking at them. */
  readonly issuedCodes: readonly string[] | undefined;
  readonly isBeginning: boolean;
  readonly isConfirming: boolean;
  /** i18n key of a refused confirmation, chosen from the problem `code`. */
  readonly failureKey: string | undefined;
  readonly begin: () => void;
  /** Throws the drafted secret away without enrolling — «not now», not «try again». */
  readonly abandon: () => void;
  readonly confirm: (values: TotpConfirmFormValues) => void;
  /** Called when the person has confirmed they saved the codes. Forgets codes *and* secret. */
  readonly dismissCodes: () => void;
}

/**
 * Enrolment, composed: the public API of this unit for the screens that draw it
 * (`rules/frontend-fsd.mdc` rule 6).
 *
 * Two mutations and no state of its own — the step the screen is on is derived from what the
 * mutations hold (`draft` present, `issuedCodes` present), never mirrored into `useState`
 * (rule 11). A copy would be a second answer to «where are we» that can disagree with the first,
 * and here the disagreement would be a screen showing a form for a secret that no longer exists.
 *
 * **`dismissCodes` forgets the secret as well as the codes**, and that is the one line here worth
 * reading twice. The secret has done its job at that point: the authenticator holds it, the server
 * holds it encrypted, and the copy in this tab is pure liability. Resetting only the codes would
 * leave a base32 secret in the mutation cache of a screen that has moved on.
 */
export const useTotpEnrolment = (): TotpEnrolment => {
  const setup = useSetupTotp();
  const confirmation = useConfirmTotp();

  return {
    draft: setup.data,
    issuedCodes: confirmation.data?.codes,
    isBeginning: setup.isPending,
    isConfirming: confirmation.isPending,
    failureKey: confirmation.error === null ? undefined : errorMessageKey(confirmation.error),
    begin: () => {
      setup.mutate();
    },
    abandon: () => {
      setup.reset();
    },
    confirm: (values: TotpConfirmFormValues) => {
      confirmation.mutate(values);
    },
    dismissCodes: () => {
      confirmation.reset();
      setup.reset();
    },
  };
};
