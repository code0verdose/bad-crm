import { Badge } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import { PROJECT_STATUS_LABEL, type ProjectStatus } from '@units/project/model';

export interface ProjectStatusBadgeProps {
  readonly status: ProjectStatus;
}

/**
 * The status as a word, not a colour: every status reads the same neutral badge, so the text is the
 * only carrier and there is no second one to disagree with it (`rules/a11y.mdc` §2).
 */
export function ProjectStatusBadge({ status }: ProjectStatusBadgeProps) {
  const { t } = useTranslation();

  return (
    <Badge color="neutral" variant="light">
      {t(PROJECT_STATUS_LABEL[status])}
    </Badge>
  );
}
