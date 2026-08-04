import { ActionIcon, Tooltip } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { IconLogout } from '@tabler/icons-react';

import { AuthService } from '@units/auth';

/**
 * The way out of the shell.
 *
 * Markup and one handler; ending the session is the unit's job, and where the tab goes afterwards
 * is the router's — the hook announces `logged-out` and `app/auth-events.util.ts` turns that into
 * the navigation and the cache wipe. This component does not know either happens.
 *
 * Icon-only, so it carries an `aria-label`: a `Tooltip` is a hint for people who can see it, never
 * an accessible name (`rules/a11y.mdc` §17). The wait sits on the control that started it rather
 * than on a page-wide spinner (`rules/errors-and-toasts.mdc` §7).
 */
export function SignOutControl() {
  const { t } = useTranslation();

  const { isPending, signOut } = AuthService.useLogout();

  return (
    <Tooltip label={t('nav.signOut')}>
      <ActionIcon
        aria-label={t('nav.signOut')}
        loading={isPending}
        onClick={signOut}
        variant="subtle"
      >
        <IconLogout size={20} stroke={1.5} />
      </ActionIcon>
    </Tooltip>
  );
}
