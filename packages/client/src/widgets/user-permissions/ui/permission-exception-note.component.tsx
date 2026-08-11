import { Stack, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import { SharedLib, SharedUi } from '@shared';

import { type IamTypes } from '@units/iam';

export interface PermissionExceptionNoteProps {
  readonly override: IamTypes.OverrideFacts;
  /** The moment «granted» is measured from. A parameter so a test can state one. */
  readonly now: Date;
}

/**
 * The exception in words: why it was written, when, and until when.
 *
 * **Rendered beside the row rather than inside a tooltip**, which is a deliberate departure from the
 * story's «наводит на бейдж». A tooltip is a hover affordance: it does not exist for a touch screen,
 * it needs a focusable wrapper to exist for a keyboard, and the sentence it hides is the single most
 * important thing on this screen — the answer to «why is this person not like their role», six
 * months after whoever knew has left. `rules/a11y.mdc` §10 asks that everything reachable by mouse
 * be reachable without one; the cheapest way to satisfy it here is not to hide the text at all.
 *
 * Only rows that actually carry an exception render this, so the cost is a handful of lines on a
 * table of three hundred.
 *
 * The dates are formatted through `shared/lib/format`, never `toLocaleDateString`: the locale is the
 * reader's and the wrappers are the only place `Intl` is constructed (`rules/i18n.mdc` §10).
 */
export function PermissionExceptionNote({ override, now }: PermissionExceptionNoteProps) {
  const { t, i18n } = useTranslation();

  return (
    <Stack gap={2}>
      <Text size="xs">{t('permissions.exception.reason', { reason: override.reason })}</Text>
      <Text c="var(--bc-text-muted)" size="xs">
        {t('permissions.exception.granted')}{' '}
        <SharedUi.RelativeTime iso={override.grantedAt} now={now} />
      </Text>
      <Text c="var(--bc-text-muted)" size="xs">
        {override.expiresAt === null
          ? t('permissions.exception.neverExpires')
          : t('permissions.exception.expires', {
              date: SharedLib.formatDate(
                override.expiresAt,
                i18n.language,
                SharedLib.resolveTimeZone(),
              ),
            })}
      </Text>
    </Stack>
  );
}
