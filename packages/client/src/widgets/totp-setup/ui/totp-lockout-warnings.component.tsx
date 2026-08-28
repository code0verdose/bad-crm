import { Alert, List, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';

/**
 * The three things somebody must know **before** they press Enable, not after.
 *
 * Every one of them was established by looking at what this installation can actually do, and each
 * one is a door that closes behind the person:
 *
 * 1. **Turning it off costs the same two proofs as signing in.** Disabling exists now (STORY-013-04,
 *    `/settings/security`) and it asks for the current password *and* a second-factor code — a live
 *    one or an unused recovery code. This used to read «there is no way to turn it off», which was
 *    true of the build that shipped enrolment and stopped being true the day the way out landed. It
 *    is still a warning rather than a reassurance: somebody with no password and no code cannot
 *    leave this screen on their own. What they are left with is somebody else — an administrator
 *    holding `user:reset_mfa` can strip the second factor from the employee's profile
 *    (`widgets/reset-mfa`, mounted on `pages/employee-profile`), which is a request to make, not a
 *    control on this page. The one account with nobody above it is the organization owner: the
 *    policy refuses a reset of the owner by anyone but the owner, and refuses a self-reset
 *    (`domain/identity/access/mfa-policy.policy.ts`), so for them the two proofs really are the
 *    only exit.
 * 2. **The recovery codes are the only way back that belongs to this person.** The database holds
 *    argon2id hashes and nothing else, so a lost code is not a code anyone can look up — not
 *    support, not whoever runs the server, which is what the string says and all it says. What
 *    remains after a lost phone and unsaved codes is the administrative reset in point 1: somebody
 *    else's decision, on somebody else's schedule, and unavailable to the owner at all. Stated as
 *    «the only way back» rather than «the only self-service way back» on purpose — the person
 *    reading it before pressing Enable is deciding what to do with a sheet of codes, and «an admin
 *    can fix it» is exactly the thought that gets the sheet closed unsaved.
 * 3. **A lost confirmation answer is a lost set of codes.** The codes travel in the response to
 *    `POST /auth/2fa/confirm` and exist in no other form; a dropped connection at that instant
 *    leaves 2FA on and the codes unseen. The way out is reissuing them, which needs the password
 *    and a live code — and this sentence is here so that the person recognises the situation when
 *    it happens rather than concluding the code they typed was wrong.
 *
 * Stated plainly rather than dramatically, and stated in advance: the alternative is somebody
 * finding out at the point where nothing can be done about it. This is an `Alert` rather than a
 * paragraph so it survives being skimmed, and it is not `color="danger"` — this is not a failure, it
 * is what the feature costs.
 */
export function TotpLockoutWarnings() {
  const { t } = useTranslation();

  return (
    <Alert color="warning" title={t('security.totp.warning.title')} variant="light">
      <List size="sm" spacing="xs">
        <List.Item>
          <Text size="sm">{t('security.totp.warning.disable')}</Text>
        </List.Item>
        <List.Item>
          <Text size="sm">{t('security.totp.warning.recoveryOnly')}</Text>
        </List.Item>
        <List.Item>
          <Text size="sm">{t('security.totp.warning.lostAnswer')}</Text>
        </List.Item>
      </List>
    </Alert>
  );
}
