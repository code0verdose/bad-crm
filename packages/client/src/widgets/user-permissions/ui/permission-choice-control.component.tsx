import { SegmentedControl } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import { IamModel } from '@units/iam';

export interface PermissionChoiceControlProps {
  readonly permission: string;
  /** Where the control currently sits — read off the exception, not off the ladder. */
  readonly value: IamModel.PermissionChoice;
  /** True while a write is in flight: one row at a time, so a second click cannot race the first. */
  readonly disabled: boolean;
  readonly onChoose: (choice: IamModel.PermissionChoice) => void;
}

/**
 * The three things an administrator can choose about one key: grant it personally, take it away
 * personally, or leave it to the roles.
 *
 * **Three positions, not five.** The server reports five sources — `OWNER`, `ROLE`,
 * `NOT_GRANTED` and the two overrides — but only two of those are anybody's decision on this
 * screen. `ROLE` and `NOT_GRANTED` are the same act here («no personal exception»), and `OWNER` is
 * not an act at all. Offering five would ask somebody to pick an outcome they do not control.
 *
 * `SegmentedControl` because it renders **real radio inputs** with a shared name: arrow keys move
 * between the positions, `Tab` enters and leaves the group, and a screen reader announces «2 of 3»
 * without a line of ARIA written here (`rules/a11y.mdc` §10). The explicit `role="radiogroup"`
 * wrapper adds the one thing the markup cannot carry — *which permission* this group is about —
 * because on a table of three hundred rows «Deny, radio button» is not an announcement anybody can
 * act on. The row header says the same thing to a reader navigating the table by cell; this says it
 * to one arriving by `Tab`.
 *
 * `aria-checked="mixed"`, which the story suggests for the inherited position, is deliberately not
 * used: `mixed` describes a **checkbox** that is partly on, and these are three exclusive choices
 * rather than one choice with a middle. A radio group is the pattern that matches the model, and it
 * is the one assistive technology already knows.
 */
export function PermissionChoiceControl({
  permission,
  value,
  disabled,
  onChoose,
}: PermissionChoiceControlProps) {
  const { t } = useTranslation();

  return (
    <div aria-label={t('permissions.controlLabel', { permission })} role="radiogroup">
      <SegmentedControl
        data={IamModel.PERMISSION_CHOICES.map((choice) => ({
          value: choice,
          label: t(IamModel.PERMISSION_CHOICE_LABEL_KEY[choice]),
        }))}
        disabled={disabled}
        // Per row, so the radios of one permission form one group and do not merge with the next
        // row's. Mantine would generate a random one; a stable name also survives a re-render.
        name={`permission-choice-${permission}`}
        onChange={(next) => {
          onChoose(next);
        }}
        size="xs"
        value={value}
      />
    </div>
  );
}
