import { Alert, List, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';

/**
 * The three things somebody must know **before** they press Enable, not after.
 *
 * Every one of them was established by looking at what this installation can actually do, and each
 * one is a door that closes behind the person:
 *
 * 1. **There is no way to turn 2FA off.** Disabling and administrator reset are STORY-013-04, which
 *    has not been built. Whoever enables it today is enabling it permanently, on this build.
 * 2. **The recovery codes are the only way back.** The database holds argon2id hashes and nothing
 *    else; a lost phone with unsaved codes is an account nobody — including the person who runs the
 *    server — can hand back.
 * 3. **A lost confirmation answer is a lost set of codes.** The codes travel in the response to
 *    `POST /auth/2fa/confirm` and exist in no other form; a dropped connection at that instant
 *    leaves 2FA on and the codes unseen. The way out is reissuing them, which needs the password
 *    and a live code — and this sentence is here so that the person recognises the situation when
 *    it happens rather than concluding the code they typed was wrong.
 *
 * Stated plainly rather than dramatically, and stated in advance: the alternative is somebody
 * finding out at the point where nothing can be done about it. This is an `Alert` rather than a
 * paragraph so it survives being skimmed, and it is not `color="red"` — this is not a failure, it
 * is what the feature costs.
 */
export function TotpLockoutWarnings() {
  const { t } = useTranslation();

  return (
    <Alert color="yellow" title={t('security.totp.warning.title')} variant="light">
      <List size="sm" spacing="xs">
        <List.Item>
          <Text size="sm">{t('security.totp.warning.noDisable')}</Text>
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
