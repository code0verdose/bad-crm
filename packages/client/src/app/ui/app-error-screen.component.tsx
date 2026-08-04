import { Button, Stack, Text, Title } from '@mantine/core';
import { useTranslation } from 'react-i18next';

export interface AppErrorScreenProps {
  /** Shown to the person and sent with the report, so both sides of a support call say the same thing. */
  readonly reference: string;
}

/**
 * What replaces the application when the application is what broke.
 *
 * Its own file because `AppErrorBoundary` is a class — `componentDidCatch` has no hook equivalent —
 * and a class cannot use `useTranslation`. One component per file is the rule anyway
 * (`rules/naming-and-structure.mdc`); here it is also the only way the text can come from the
 * catalogue.
 */
export function AppErrorScreen({ reference }: AppErrorScreenProps) {
  const { t } = useTranslation();

  return (
    <Stack align="center" component="main" gap="md" justify="center" p="xl">
      <Title order={1}>{t('errors.app.title')}</Title>
      <Text>{t('errors.app.description')}</Text>
      <Button
        onClick={() => {
          globalThis.location.reload();
        }}
      >
        {t('errors.app.reload')}
      </Button>
      <Text c="dimmed" data-testid="app-error-reference" size="sm">
        {reference}
      </Text>
    </Stack>
  );
}
