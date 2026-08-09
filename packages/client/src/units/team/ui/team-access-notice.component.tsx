import { Alert } from '@mantine/core';
import { useTranslation } from 'react-i18next';

/**
 * «A team grants nothing» — criterion 10 of STORY-012-07, as a sentence on the screen.
 *
 * It is a criterion because the interface is otherwise misleading in a way nothing corrects. A team
 * has members, it is administered from the same section as roles and permissions, and putting five
 * people on one looks exactly like delegating something to five people. It delegates nothing: the
 * `ResourceAcl` that would make a team the subject of a grant is not part of this release, and
 * separate access groups (`subjectType = GROUP`) are open question 3 of `permission-model.md` §12
 * rather than something M2 introduces.
 *
 * An administrator who believes otherwise does not find out by being refused — they find out when
 * somebody cannot open a project they were sure had been shared. The cheapest correction is to say
 * it where the belief forms, which is both screens that manage a team.
 *
 * `Alert` rather than a muted line, and blue rather than yellow: this is how the product works, not
 * a warning that something is wrong, and not something to dismiss — a notice that can be closed is a
 * notice that is closed once and never read again.
 */
export function TeamAccessNotice() {
  const { t } = useTranslation();

  return (
    <Alert color="blue" title={t('teams.notAccessGroup.title')} variant="light">
      {t('teams.notAccessGroup.description')}
    </Alert>
  );
}
