import { Stack, Text } from '@mantine/core';

import { SharedUi } from '@shared';

import classes from './page.module.css';

/**
 * The public entry point, without a form yet.
 *
 * The sign-in flow — credentials, 2FA, the session it creates — is EPIC-006, and inventing a form
 * that posts nowhere would be a fallback pretending to be a feature. What exists here now is what
 * the router needs to be complete: a real route outside `_authenticated`, so that `requireSession`
 * has somewhere to send an anonymous visitor and `redirectIfAuthed` has somewhere to send them back
 * from.
 *
 * The full-height centring is a class, not a `h="100dvh"` style prop: style props are inline styles
 * by another name (`rules/design-system.mdc` §5), and this one also broke the test runner — jsdom
 * cannot resolve `dvh` in `getComputedStyle` and threw while looking for a heading.
 */
export function LoginPage() {
  return (
    <Stack align="center" className={classes['root']} gap="sm" justify="center">
      <SharedUi.PageHeader titleKey="auth.login.title" />
      <Text c="var(--bc-text-muted)" ta="center">
        auth.login.comingSoon
      </Text>
    </Stack>
  );
}
