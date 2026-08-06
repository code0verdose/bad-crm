import { type ReactNode } from 'react';
import { type SharedPermissions } from '@bad-crm/shared';

import { IamHooks } from '@units/iam/service';

export interface CanProps {
  /** A key of the catalogue. A string the catalogue does not contain renders nothing — fail-closed. */
  readonly permission: string;
  /** The level held on the object, where the permission is resource-scoped. */
  readonly accessLevel?: SharedPermissions.AccessLevel;
  readonly children: ReactNode;
  /** What to show instead. Absent means «show nothing», which is the honest default. */
  readonly fallback?: ReactNode;
}

/**
 * Renders its children when the caller may do the thing — a **hint**, not a gate.
 *
 * Hiding a control the person cannot use is a kindness, not a security measure: the request behind
 * it is authorised on the server every time. Which is why the fallback defaults to nothing rather
 * than to an explanation — a screen that lists what you are not allowed to do is a map of the
 * organization's structure handed to whoever is looking.
 */
export const Can = ({ permission, accessLevel, children, fallback }: CanProps): ReactNode => {
  const { can } = IamHooks.useCan();

  return can(permission, accessLevel) ? children : (fallback ?? null);
};
