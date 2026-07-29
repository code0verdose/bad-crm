import { Alert } from '@mantine/core';

/**
 * The wording is the security control. «If this address is registered, a message has been sent» is
 * the only sentence that matches what the server actually answered — 202, with no body, for a known
 * address and an unknown one alike (`docs/api/openapi.yaml` → `requestPasswordReset`). «We have sent
 * you a mail» would be a claim the client cannot make, and a claim that turns the screen into the
 * account-enumeration oracle the operation is built to avoid.
 */
const SENT_MESSAGE_KEY = 'auth.forgotPassword.sent';

/**
 * What replaces the form once the request has been accepted.
 *
 * A live region rather than a toast, and it replaces the form rather than sitting above it. One
 * logical action gets one signal (`rules/errors-and-toasts.mdc` §2), and here the signal has to
 * survive being read slowly: it tells the person to go and look in their mail, which is not
 * something to say for five seconds in the corner. `role="status"` with `aria-live="polite"` is what
 * makes the swap audible to somebody who cannot see the form disappear (`rules/a11y.mdc` §13).
 */
export function PasswordResetSent() {
  return (
    <Alert aria-live="polite" color="blue" role="status" variant="light">
      {SENT_MESSAGE_KEY}
    </Alert>
  );
}
