import { Button, Group, NativeSelect, NumberInput, Text } from '@mantine/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { SharedHooks } from '@shared';

import { type ProjectCandidate } from '@units/project/lib';
import { PROJECT_ROLE_LABEL, PROJECT_ROLES, type ProjectRole } from '@units/project/model';

export interface ProjectMemberAddFormProps {
  readonly candidates: readonly ProjectCandidate[];
  readonly isPending: boolean;
  readonly onAdd: (
    userId: string,
    projectRole: ProjectRole,
    allocationPct: number,
    onAdded: () => void,
  ) => void;
}

/** What a new member's share of their time starts as — the contract's own default. */
const DEFAULT_ALLOCATION = 100;
const MAX_ALLOCATION = 100;

/**
 * Putting somebody on the project: a person, a role, a share of their time, one button.
 *
 * **When there is nobody left to choose, the form is a sentence instead** — a picker holding only its
 * placeholder is a control that opens and offers nothing. The placeholder is not a person and the
 * button stays unusable until one is chosen: a form armed on arrival, on a screen where arming it
 * grants somebody access to the project, is the wrong default.
 *
 * **Adding the last candidate replaces the form with that sentence**, and the button that was
 * pressed goes with it — focus would fall to `<body>`. The sentence takes it instead
 * (`useFocusIfLost`), armed only once this form has added somebody: a screen that *opens* with
 * nobody left to add must not pull focus to it.
 *
 * The share is held to `0…100` by the input itself (`clampBehavior="strict"`), the bound the
 * contract and the database both hold (STORY-014-02, acceptance 9). The inputs clear once the server
 * agrees, not before — a refusal leaves the choice on screen to be corrected.
 */
export function ProjectMemberAddForm({ candidates, isPending, onAdd }: ProjectMemberAddFormProps) {
  const { t } = useTranslation();
  const [userId, setUserId] = useState('');
  const [projectRole, setProjectRole] = useState<ProjectRole>('MEMBER');
  const [allocationPct, setAllocationPct] = useState<number>(DEFAULT_ALLOCATION);
  const [hasAdded, setHasAdded] = useState(false);
  const claimFocus = SharedHooks.useFocusIfLost(hasAdded);

  if (candidates.length === 0) {
    return (
      <Text ref={claimFocus} size="sm" tabIndex={-1}>
        {t('projects.members.add.none')}
      </Text>
    );
  }

  return (
    <Group align="flex-end" gap="sm" wrap="wrap">
      <NativeSelect
        data={[{ value: '', label: t('projects.members.add.choose') }, ...candidates]}
        label={t('projects.members.add.person')}
        onChange={(event) => {
          setUserId(event.currentTarget.value);
        }}
        value={userId}
      />
      <NativeSelect
        data={PROJECT_ROLES.map((value) => ({ value, label: t(PROJECT_ROLE_LABEL[value]) }))}
        label={t('projects.members.add.role')}
        onChange={(event) => {
          setProjectRole(event.currentTarget.value as ProjectRole);
        }}
        value={projectRole}
      />
      <NumberInput
        allowDecimal={false}
        allowNegative={false}
        clampBehavior="strict"
        label={t('projects.members.add.allocation')}
        max={MAX_ALLOCATION}
        min={0}
        onChange={(value) => {
          // An emptied field is `''`, which is 0 — the input's own lower bound.
          setAllocationPct(Number(value));
        }}
        value={allocationPct}
      />
      <Button
        disabled={userId === ''}
        loading={isPending}
        onClick={() => {
          onAdd(userId, projectRole, allocationPct, () => {
            setUserId('');
            setHasAdded(true);
          });
        }}
      >
        {t('projects.members.add.submit')}
      </Button>
    </Group>
  );
}
