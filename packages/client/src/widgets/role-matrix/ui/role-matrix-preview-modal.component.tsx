import { Alert, Badge, Button, Group, List, Modal, Stack, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import { IamModel, type IamApi } from '@units/iam';

export interface RoleMatrixPreviewModalProps {
  readonly opened: boolean;
  readonly outcomes: readonly IamApi.RoleChangeOutcome[];
  readonly isSaving: boolean;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}

/**
 * «Kого затронет» — the summary between the draft and the save.
 *
 * Every number and every verdict here comes from the server, computed by the policy that will decide
 * the save. The screen could have subtracted two arrays itself; what it could not compute is how
 * many people hold each role and whether the change would be accepted, and a summary that is right
 * about the first two things and wrong about the third is worse than none.
 *
 * Confirmation is refused outright when anything is refused: the endpoint applies all of it or none,
 * so offering «save anyway» would offer something that cannot happen.
 */
export function RoleMatrixPreviewModal({
  opened,
  outcomes,
  isSaving,
  onConfirm,
  onClose,
}: RoleMatrixPreviewModalProps) {
  const { t } = useTranslation();
  // Narrowed here rather than at each use: `reason` is `string | null` on the wire, and a fallback
  // for «null after we filtered out null» is a branch that can only ever be half-tested.
  const refused = outcomes.flatMap((outcome) =>
    outcome.reason === null ? [] : [{ ...outcome, reason: outcome.reason }],
  );
  const dangerous = outcomes.filter((outcome) => outcome.dangerous.length > 0);

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={t('roles.preview.title')}
      size="lg"
      // Mantine's close button renders as an icon with no text, and an icon-only control without a
      // name is a button a screen reader announces as «button». axe fails the modal on it.
      closeButtonProps={{ 'aria-label': t('roles.preview.close') }}
    >
      <Stack gap="md">
        {refused.length > 0 && (
          <Alert color="red" title={t('roles.preview.refusedTitle')}>
            <List>
              {refused.map((outcome) => (
                <List.Item key={outcome.roleId}>
                  {`${outcome.name} — ${t(
                    IamModel.ROLE_CHANGE_REFUSAL_KEY[outcome.reason] ?? 'roles.refusal.unknown',
                  )}`}
                </List.Item>
              ))}
            </List>
          </Alert>
        )}

        {dangerous.length > 0 && refused.length === 0 && (
          <Alert color="yellow" title={t('roles.preview.dangerousTitle')}>
            {t('roles.preview.dangerousBody')}
          </Alert>
        )}

        <List spacing="xs">
          {outcomes.map((outcome) => (
            <List.Item key={outcome.roleId}>
              <Group gap="xs">
                <Text fw={600}>{outcome.name}</Text>
                <Badge variant="light">
                  {t('roles.preview.holders', { count: outcome.holderCount })}
                </Badge>
                <Text c="green">{t('roles.preview.added', { count: outcome.added.length })}</Text>
                <Text c="red">{t('roles.preview.removed', { count: outcome.removed.length })}</Text>
              </Group>
            </List.Item>
          ))}
        </List>

        <Group justify="flex-end">
          <Button variant="default" onClick={onClose} disabled={isSaving}>
            {t('roles.preview.cancel')}
          </Button>
          <Button onClick={onConfirm} loading={isSaving} disabled={refused.length > 0}>
            {t('roles.preview.confirm')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
