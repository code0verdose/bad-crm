import { Badge, Stack, Text } from '@mantine/core';
import { type SharedPermissions } from '@bad-crm/shared';
import { useTranslation } from 'react-i18next';

import { SharedLib } from '@shared';

import { IamModel } from '@units/iam';

export interface PermissionSourceBadgeProps {
  /** Which layer decided — the server's word, never recomputed here. */
  readonly source: SharedPermissions.CapabilitySource;
  /** The roles that grant this key, by name. Empty means «inherits nothing». */
  readonly inheritedFrom: readonly string[];
}

/**
 * What answered for this key, and what the roles would say if the exception went away.
 *
 * The second line is the part that makes the control below it honest. `roleIds` arrives **whatever
 * the source is** — including under a DENY, where the roles are being overruled
 * (`permission-model.md` §7(ж)) — so «back to inherited» can state its consequence instead of
 * implying one. «Inherits nothing» and «inherits from Manager» are different futures, and a control
 * that offered the same word for both would be asking somebody to guess.
 *
 * The badge carries a **word**, not only a colour (`rules/a11y.mdc` §2): five sources rendered as
 * five shades is a legend nobody has.
 */
export function PermissionSourceBadge({ source, inheritedFrom }: PermissionSourceBadgeProps) {
  const { t, i18n } = useTranslation();

  return (
    <Stack gap={2}>
      <Badge
        color={IamModel.PERMISSION_SOURCE_TONE[source] === 'granted' ? 'teal' : 'gray'}
        variant="light"
      >
        {t(IamModel.PERMISSION_SOURCE_LABEL_KEY[source])}
      </Badge>
      <Text c="var(--bc-text-muted)" size="xs">
        {inheritedFrom.length === 0
          ? t('permissions.inheritsNothing')
          : // `Intl.ListFormat` through the wrapper, not `join(', ')`: «Manager and Developer» and
            // «Manager и Developer» are different sentences, and the rule producing both is locale
            // data rather than a branch here (`rules/i18n.mdc` §7).
            t('permissions.inheritsFrom', {
              roles: SharedLib.formatList([...inheritedFrom], i18n.language),
            })}
      </Text>
    </Stack>
  );
}
