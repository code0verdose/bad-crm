import { Badge } from '@mantine/core';
import {
  IconArchive,
  IconCircleCheck,
  IconPlayerPause,
  IconPlayerPlay,
  type Icon,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';

import { PROJECT_STATUS_LABEL, type ProjectStatus } from '@units/project/model';

export interface ProjectStatusBadgeProps {
  readonly status: ProjectStatus;
}

/**
 * A shape per status, so a status in a grid of cards is recognised before it is read. A total map
 * over the union: a status the contract adds stops this compiling instead of drawing no icon.
 */
const STATUS_ICON: Readonly<Record<ProjectStatus, Icon>> = {
  ACTIVE: IconPlayerPlay,
  ON_HOLD: IconPlayerPause,
  CLOSED: IconCircleCheck,
  ARCHIVED: IconArchive,
};

/**
 * The status as a word and an icon, never as a colour: every status reads the same neutral badge,
 * so the text carries the meaning and the icon repeats it (`rules/a11y.mdc` §2; STORY-014-04,
 * acceptance 11). The icon is decorative — the word is what a screen reader reads.
 */
export function ProjectStatusBadge({ status }: ProjectStatusBadgeProps) {
  const { t } = useTranslation();
  const StatusIcon = STATUS_ICON[status];

  return (
    <Badge
      color="neutral"
      leftSection={<StatusIcon aria-hidden size={16} stroke={1.5} />}
      variant="light"
    >
      {t(PROJECT_STATUS_LABEL[status])}
    </Badge>
  );
}
