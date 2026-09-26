import { Alert } from '@mantine/core';
import { useTranslation } from 'react-i18next';

/**
 * «Membership alone grants nothing» — criterion 10 of STORY-012-07, as a sentence on the screen.
 *
 * It is a criterion because the interface is otherwise misleading in a way nothing corrects. A team
 * has members, it is administered from the same section as roles and permissions, and putting five
 * people on one looks exactly like delegating something to five people. Membership delegates
 * nothing by itself: a team reaches an object only through an explicit `ResourceAcl` grant whose
 * subject is that team (`POST /api/v1/acl`, since 2026-09-26, on a project or the organization), and
 * then every member gets it. The client has no screen for that grant yet, so the notice says the
 * grant is made through the API rather than pointing at a control that does not exist.
 *
 * An administrator who believes membership is enough does not find out by being refused — they find
 * out when somebody cannot open a project they were sure had been shared. The cheapest correction is
 * to say it where the belief forms, which is both screens that manage a team.
 *
 * `Alert` rather than a muted line, and blue rather than yellow: this is how the product works, not
 * a warning that something is wrong, and not something to dismiss — a notice that can be closed is a
 * notice that is closed once and never read again.
 */
export function TeamAccessNotice() {
  const { t } = useTranslation();

  return (
    <Alert color="info" title={t('teams.notAccessGroup.title')} variant="light">
      {t('teams.notAccessGroup.description')}
    </Alert>
  );
}
