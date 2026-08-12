import { MantineThemeProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { useTranslation } from 'react-i18next';
import { type ComponentProps } from 'react';

export interface ToasterProps {
  /** How many signals may share the screen before the rest wait in the queue. */
  readonly limit: number;
  readonly position: NonNullable<ComponentProps<typeof Notifications>['position']>;
}

/**
 * The application's one toast surface — `<Notifications />` plus the one thing it will not do for
 * itself: name its close button.
 *
 * **The defect this component exists for.** Mantine renders each notification's dismiss control as
 * an icon-only `CloseButton` with no text and no `aria-label`, so a screen reader announces it as
 * «button» and axe reports `button-name` on every toast the product raises. It was found by running
 * axe over a screen that raises one (`test/widgets/totp-setup.test.tsx`) — the component tests of
 * the toaster mounted `<Notifications />` directly and never scanned a rendered toast, so nothing
 * had looked. `rules/a11y.mdc` §17: an icon button always carries a label.
 *
 * **Why a theme provider rather than a prop on every toast.** `Notifications` has no prop for it and
 * `notifications.show` is called from `notify`, which is a module-level utility with no i18n
 * context — the same constraint that makes `ToastMessage` a component. A scoped
 * `MantineThemeProvider` (inheriting, so nothing else about the theme changes) sets the default for
 * every `Notification` rendered underneath, once, from inside the tree where translations live.
 */
export function Toaster({ limit, position }: ToasterProps) {
  const { t } = useTranslation();

  return (
    <MantineThemeProvider
      theme={{
        components: {
          Notification: {
            defaultProps: {
              closeButtonProps: { 'aria-label': t('common.notification.dismiss') },
            },
          },
        },
      }}
    >
      <Notifications limit={limit} position={position} />
    </MantineThemeProvider>
  );
}
