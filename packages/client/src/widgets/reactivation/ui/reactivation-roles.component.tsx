import { Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import { SharedLib } from '@shared';

import { IamService } from '@units/iam';

export interface ReactivationRolesProps {
  readonly userId: string;
}

/**
 * The roles this account will still be holding a second after it comes back, by name.
 *
 * **Why the dialog has to say them out loud.** Switching an account off does not take its roles
 * away — access is closed by the status and the permission version, and a role is a *composition*
 * that nothing could put back (STORY-012-06). So reactivation hands the whole of somebody's former
 * power back in one call, with no second decision anywhere, and the difference between «bring Ivan
 * back» and «bring an administrator back» is a sentence nobody would otherwise read.
 *
 * **It is a component rather than a line in the dialog, because it is a request.** Only
 * `GET /users/{userId}/permissions` names them — the personnel document carries no roles — and that
 * answer needs `permission:override_read`, which a holder of `user:reactivate` need not have. Being
 * a child means the dialog can decline to mount it, and a request that would always be refused is
 * never spent (`ux-architecture.md`, принцип 6). Being mounted only while the dialog is open means
 * it is not spent on merely opening the card either: Mantine's `Modal` does not render its children
 * while closed (`keepMounted` defaults to `false`).
 *
 * **Every outcome says something different**, and the reason is that this is a claim about somebody
 * else's power. «Loading» rendered as «no roles» would be a false all-clear on the one screen where
 * a false all-clear matters; so would a failed read.
 */
export function ReactivationRoles({ userId }: ReactivationRolesProps) {
  const { t, i18n } = useTranslation();
  const { status, names } = IamService.IamHooks.useHeldRoleNames(userId);

  if (status === 'pending') return <Text size="sm">{t('members.reactivate.roles.pending')}</Text>;
  if (status === 'error') {
    return <Text size="sm">{t('members.reactivate.roles.unavailable')}</Text>;
  }
  if (names.length === 0) return <Text size="sm">{t('members.reactivate.roles.none')}</Text>;

  return (
    <Text size="sm">
      {t('members.reactivate.roles.named', {
        // `Intl.ListFormat` through the shared wrapper, never `join(', ')`: English wants «and»
        // before the last item and Russian wants «и» without the comma (`rules/i18n.mdc` §7).
        roles: SharedLib.formatList(names, i18n.language),
      })}
    </Text>
  );
}
