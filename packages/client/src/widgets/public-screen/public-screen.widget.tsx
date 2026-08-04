import { type ReactNode } from 'react';

import { SharedUi } from '@shared';

export interface PublicScreenProps {
  readonly children: ReactNode;
}

/**
 * Every screen reachable without a session: the centred column, plus the language switch.
 *
 * The switch has to be *here* rather than inside `CenteredScreen`, and the reason is a layer rule
 * rather than taste. `CenteredScreen` lives in `shared/ui`, so it cannot reach sideways to another
 * `shared/ui` folder — importing into a layer past its barrel is forbidden, and a relative parent
 * import is forbidden too (`rules/frontend-fsd.mdc`). Composition belongs one layer up, which is
 * what a widget is: `shared` supplies the pieces, `widgets` decides what a public screen is made of.
 *
 * Stating it once matters more than saving three lines. «Public screens offer a language switch» is
 * a policy, and a policy repeated in three pages is a policy that survives in two of them after the
 * next edit — the sign-in screen keeps the switch and the recovery screens quietly lose it.
 */
export function PublicScreen({ children }: PublicScreenProps) {
  return (
    <SharedUi.CenteredScreen>
      {children}
      <SharedUi.LanguageControl />
    </SharedUi.CenteredScreen>
  );
}
