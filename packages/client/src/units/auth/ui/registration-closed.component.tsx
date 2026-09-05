import { Alert } from '@mantine/core';
import { useTranslation } from 'react-i18next';

/**
 * What replaces the form when the installation answers `registration_disabled`.
 *
 * It replaces the form rather than sitting above it, and that is the acceptance criterion rather
 * than a preference: a closed installation creates no organizations, so leaving five fields on
 * screen invites somebody to fill them in a second time for the same 403. One logical action gets
 * one signal (`rules/errors-and-toasts.mdc` §2), and here the signal has to survive being read
 * slowly — it says «ask whoever runs this installation», which is not something to say for five
 * seconds in the corner. `role="status"` with `aria-live="polite"` makes the swap audible to
 * somebody who cannot see the form disappear (`rules/a11y.mdc` §13).
 *
 * Both strings go through `t()`, and `packages/client/test/i18n/pseudo-locale.test.tsx` mounts this
 * component to prove it. Under `cimode` — the suite's default — a forgotten `t()` renders
 * identically to a remembered one, so no other test in the tree can tell the two apart.
 */
export function RegistrationClosed() {
  const { t } = useTranslation();

  return (
    <Alert
      aria-live="polite"
      color="warning"
      role="status"
      title={t('auth.register.closed.title')}
      variant="light"
    >
      {t('auth.register.closed.description')}
    </Alert>
  );
}
