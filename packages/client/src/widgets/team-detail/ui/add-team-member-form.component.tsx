import { Button, Group, NativeSelect, Text } from '@mantine/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

// `@widgets/team-detail/lib` is the segment's barrel, not a path inside it and not a `../`: the
// widget's own `lib` is reachable by alias exactly the way `@shared/lib` is (`rules/frontend-fsd.mdc`
// rules 2–3).
import { type TeamCandidate } from '@widgets/team-detail/lib';
import { TeamModel } from '@units/team';

export interface AddTeamMemberFormProps {
  readonly candidates: readonly TeamCandidate[];
  readonly isPending: boolean;
  readonly onAdd: (userId: string, teamRole: TeamModel.TeamRole) => void;
}

/**
 * Written out rather than composed from the value. ADR-0019 forbids assembling a key at runtime: a
 * key built from the role cannot be found by reading the source, and the parity gate would report
 * two translated strings as zero used ones.
 */
const ROLE_KEYS = TeamModel.TEAM_ROLE_LABEL;

/**
 * Putting somebody on the team: choose a person, choose what they are, press the button.
 *
 * **When there is nobody left to choose, the form is a sentence instead.** A picker holding only its
 * own placeholder is a control that opens and offers nothing — the same defect as a button that
 * always answers 403, one interaction further in.
 *
 * The placeholder option is not a person and the button stays unusable until one is chosen. The
 * alternative — pre-selecting whoever happens to be first alphabetically — is a form that is armed
 * on arrival, on a screen where the arming adds a colleague to a team.
 *
 * `NativeSelect` rather than `Select`: the list is short, the native control is what a phone renders
 * as its own picker and a screen reader already knows, and Mantine's `Select` carries `Combobox`
 * with a popover into a chunk that needs none of it (`ux-architecture.md` → «Бюджет бандла»).
 */
export function AddTeamMemberForm({ candidates, isPending, onAdd }: AddTeamMemberFormProps) {
  const { t } = useTranslation();
  const [userId, setUserId] = useState('');
  const [teamRole, setTeamRole] = useState<TeamModel.TeamRole>('MEMBER');

  if (candidates.length === 0) {
    return <Text size="sm">{t('teams.members.add.none')}</Text>;
  }

  return (
    <Group align="flex-end" gap="sm" wrap="wrap">
      <NativeSelect
        data={[{ value: '', label: t('teams.members.add.choose') }, ...candidates]}
        label={t('teams.members.add.person')}
        onChange={(event) => {
          setUserId(event.currentTarget.value);
        }}
        value={userId}
      />
      <NativeSelect
        data={TeamModel.TEAM_ROLES.map((value) => ({ value, label: t(ROLE_KEYS[value]) }))}
        description={t('teams.members.add.roleHint')}
        label={t('teams.members.add.role')}
        onChange={(event) => {
          setTeamRole(event.currentTarget.value as TeamModel.TeamRole);
        }}
        value={teamRole}
      />
      <Button
        disabled={userId === ''}
        loading={isPending}
        onClick={() => {
          onAdd(userId, teamRole);
        }}
      >
        {t('teams.members.add.submit')}
      </Button>
    </Group>
  );
}
