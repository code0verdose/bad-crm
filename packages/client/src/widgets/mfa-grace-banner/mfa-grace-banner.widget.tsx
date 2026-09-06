import { Alert, Anchor, Group, Text } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

import { SharedUi } from '@shared';

import { AuthService } from '@units/auth';

/**
 * «Your role needs a second factor, and here is how long you have» (acceptance 4).
 *
 * Drawn for every session the policy covers and that has not yet enrolled — and for nobody else: the
 * sign-in answer carries `mfaGraceEndsAt` only then, so a session with no requirement renders
 * nothing at all rather than an empty region.
 *
 * **It cannot be dismissed, and that is the requirement rather than an oversight.** A banner
 * somebody can close is a deadline they will not see again, and the thing on the other side of this
 * one is a session that can do nothing but enrol.
 *
 * **The countdown is live.** `useMfaGraceCountdown` re-reads the clock once a second — the one
 * legitimate timer in this screen, with the interval cleared on unmount by `useInterval` — so the
 * last hour reads honestly instead of freezing on «in 1 day» until somebody reloads. The phrase
 * itself is `Intl.RelativeTimeFormat` through `RelativeTime`, which also carries the exact instant
 * in a `<time>` element for anybody who needs more than «in 6 days».
 *
 * **A link, not a button.** Setting up an authenticator is a place — `/settings/security` — and a
 * button that navigates is a place a keyboard user cannot open in a new tab (`rules/a11y.mdc` §4).
 */
export function MfaGraceBanner() {
  const { t } = useTranslation();
  const countdown = AuthService.useMfaGraceCountdown();

  if (countdown === null) return null;

  return (
    /*
      **No live region, deliberately.** An `Alert` here is a standing notice: it is present from the
      first paint of every screen, so there is nothing for `aria-live` to announce that reading the
      page does not already give. Marked `role="status"` it would be worse than useless — the phrase
      inside it is re-rendered by the countdown, once a minute in the last hour and once a second in
      the last minute, and a polite live region would read the deadline over whatever its owner is
      doing, on every page, exactly when they are trying to act on it (`rules/a11y.mdc` §13).
    */
    <Alert color="warning" title={t('organization.grace.title')} variant="light">
      <Text size="sm">{t('organization.grace.body')}</Text>
      <Group gap="xs" mt="xs">
        {/* The label and the phrase are separate nodes because the phrase is an element — a `<time>`
            carrying the exact instant — and an interpolated value cannot be one. */}
        <Text size="sm">
          {t('organization.grace.deadline')}{' '}
          <SharedUi.RelativeTime iso={countdown.endsAt} now={countdown.now} />
        </Text>
        <Anchor component={Link} size="sm" to="/settings/security">
          {t('organization.grace.action')}
        </Anchor>
      </Group>
    </Alert>
  );
}
