import { Code, Stack, Text, Title } from '@mantine/core';
import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { PAGE_TITLE_ID } from '@shared/ui';

import classes from './forbidden-state.module.css';
import { FORBIDDEN_TITLE_KEY } from './forbidden-title-key.constant.js';

export interface ForbiddenStateProps {
  /**
   * The permission the person is missing, verbatim — `role:read`, `invitation:create`.
   *
   * A plain string rather than a catalogue type: `shared/ui` knows no domain
   * (`rules/design-system.mdc` §9), and what this component does with it is print it. The caller —
   * `app/ui/route-forbidden.component.tsx` — is where the value is typed.
   */
  readonly permission: string;
  /** The way out. Supplied by the caller, because `shared/ui` knows no routes either. */
  readonly action?: ReactNode;
}

/**
 * The 403 screen: «this exists, you may not open it, and here is what you are missing».
 *
 * It is the counterpart of `RouteNotFound`, and the difference between them is a product decision
 * rather than a stylistic one (`ux-architecture.md` → «403 vs 404»). Where the existence of a thing
 * is itself confidential — another team's project, a private channel, a vault item — the refusal has
 * to be indistinguishable from «no such address», or the application becomes an oracle for what
 * exists. Where the section is in everybody's navigation, that same silence is a lie the reader
 * cannot act on: they retry, they doubt the product, they write to support. So this screen says the
 * one thing that turns a refusal into a request an administrator can grant — the permission key.
 *
 * **There is no «request access» button**, and its absence is deliberate. The rule used to promise
 * one; the product has no request mechanism, and a control that opens nothing is worse than no
 * control — it promises a path that does not exist and leaves the person waiting for an answer
 * nobody will send. `ux-architecture.md` now records the button as arriving with the mechanism.
 *
 * The heading is the page's `h1` and carries `PAGE_TITLE_ID`: this screen replaces the route's
 * content entirely, so it is the only heading on the page, and the route announcer moves focus to
 * that id after a navigation (`rules/a11y.mdc` §21). Without it a keyboard user arrives at a
 * refusal with focus still on the link they left, and a screen reader says nothing at all.
 */
export function ForbiddenState({ permission, action }: ForbiddenStateProps) {
  const { t } = useTranslation();

  return (
    <Stack className={classes['root']} gap="sm" data-testid="forbidden-state">
      <Title id={PAGE_TITLE_ID} order={1} size="h3" tabIndex={-1}>
        {t(FORBIDDEN_TITLE_KEY)}
      </Title>
      <Text>{t('errors.forbidden.description')}</Text>
      {/* Label and value, not a sentence with a hole in it: the key is an identifier from the
          closed catalogue and must reach the reader unchanged in both languages — the exact string
          they will quote to an administrator (`rules/i18n.mdc` §7 forbids assembling a sentence
          from pieces; this is a labelled value, which is why the label is a whole phrase). */}
      <Text component="p">
        {t('errors.forbidden.permissionLabel')} <Code>{permission}</Code>
      </Text>
      {action}
    </Stack>
  );
}
