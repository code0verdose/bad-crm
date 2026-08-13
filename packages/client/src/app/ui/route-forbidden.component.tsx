import { Button } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { type SharedPermissions } from '@bad-crm/shared';

import { SharedUi } from '@shared';

export interface RouteForbiddenProps {
  /** The permission the guard asked for — typed here, where the catalogue may be named. */
  readonly permission: SharedPermissions.PermissionKey;
}

/**
 * The 403 screen with the way out attached (`ux-architecture.md` → «403 vs 404»).
 *
 * The screen itself is `shared/ui` and knows no routes; where «back» leads is an application
 * decision, so it is made here — the same division `RouteNotFound` uses for the same reason. The
 * shell stays around it, so the navigation is on screen too: this is a refusal, not a dead end.
 *
 * No retry. `reset` re-runs the loader, and a permission that was missing a moment ago is missing
 * still — a button that reliably fails is worse than no button. The one thing that legitimately
 * changes the answer is somebody granting the permission, and that is followed by
 * `router.invalidate()` on the session event (`app/auth-events.util.ts`).
 */
export function RouteForbidden({ permission }: RouteForbiddenProps) {
  const { t } = useTranslation();

  return (
    <SharedUi.ForbiddenState
      action={
        <Button component={Link} to="/dashboard" variant="light">
          {t('errors.forbidden.action')}
        </Button>
      }
      permission={permission}
    />
  );
}
