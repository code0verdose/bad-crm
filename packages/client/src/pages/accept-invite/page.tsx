import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Text } from '@mantine/core';

import { SharedLib, SharedUi } from '@shared';

import { PublicScreen } from '@widgets/public-screen';
import { AuthService } from '@units/auth';
import { IamModel, IamUi } from '@units/iam';

/**
 * `getRouteApi`, not an import of the route file: a page may not import from `app/`
 * (`rules/frontend-fsd.mdc` rule 1), and this gives the same typed `useParams` through the
 * registered route tree instead of through a dependency pointing the wrong way.
 */
const route = getRouteApi('/invite/$token');

/**
 * `/invite/$token` — the screen the invitation link opens.
 *
 * Composition only (`rules/frontend-fsd.mdc` rule 7). The token comes from the path, goes into the
 * mutation, and leaves in a request body; nothing renders it and nothing puts it in a query string
 * (`docs/security/threat-model.md`, T-IAM-07).
 *
 * **No guard.** A signed-in visitor may legitimately hold an invitation to a second organization,
 * and the credential this route runs on is the token rather than a session.
 *
 * Success ends in the application rather than at `/login`: the server issues a session with the
 * account, so asking the person to type the password they chose four seconds ago would be a step
 * that exists for no reason.
 */
export function AcceptInvitePage() {
  const { t, i18n } = useTranslation();

  const { token } = route.useParams();
  const navigate = useNavigate();
  const accept = AuthService.useAcceptInvitation();

  return (
    <PublicScreen>
      <SharedUi.PageHeader titleKey="members.accept.title" />
      <Text>{t('members.accept.description')}</Text>

      <IamUi.AcceptInvitationForm
        defaultLocale={IamModel.invitationLocaleOf(i18n.language)}
        isPending={accept.isPending}
        onSubmit={(values) => {
          accept.mutate(
            {
              token,
              password: values.password,
              locale: values.locale,
              timezone: SharedLib.resolveTimeZone(),
            },
            {
              // Only on an answer that actually was a session. `adoptSession` returns `null` for a
              // document it cannot parse — a mismatched deployment — and navigating then would send
              // somebody into the application without a token, where the first guard bounces them
              // back out with no idea why.
              onSuccess: (outcome) => {
                if (outcome.identity === null) return;

                void navigate({ to: '/', replace: true });
              },
            },
          );
        }}
      />
    </PublicScreen>
  );
}
