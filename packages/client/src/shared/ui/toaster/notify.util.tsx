import { notifications } from '@mantine/notifications';

import { type NotificationPort, type NotificationRequest } from '@shared/lib';

import { ToastMessage } from './toast-message.component.js';

/**
 * The one wrapper over `@mantine/notifications` (`rules/errors-and-toasts.mdc` §1).
 *
 * Components never call the vendor: they call this, so that three product rules hold in one place
 * instead of in every call site.
 *
 * 1. **A signal carries a key, never a sentence.** The catalogue is `errors.json`/`common.json` in
 *    both languages and the text is chosen at render time (`rules/i18n.mdc` §1) — by
 *    `ToastMessage`, which is a component because that is where the i18n context is (EPIC-008).
 * 2. **One id, one toast.** A repeat updates the toast that is already on screen instead of
 *    appending a twin (§6). This is what keeps a retrying mutation from building a pile.
 * 3. **Failure is assertive, everything else is polite** (`rules/a11y.mdc` §13): a screen reader
 *    interrupts for an error and waits its turn for a success.
 */

/** How long a signal stays before it closes itself; a failure waits for the user. */
const AUTO_CLOSE_MS = 5000;

/**
 * Ids currently on screen or in the queue.
 *
 * Mantine has no «show or update» call, and `update` on an unknown id is a no-op — so the choice
 * has to be made here, and it has to be made from state that follows the toast's real life:
 * `onClose` fires when it is removed by the timer, by the close button or by a swipe, and an id
 * left behind would make the *next* occurrence of that failure silently do nothing.
 */
const live = new Set<string>();

type ToastKind = 'error' | 'success' | 'loading';

interface ToastStyle {
  readonly color?: string;
  readonly loading: boolean;
  readonly autoClose: number | false;
  readonly role: 'alert' | 'status';
}

const STYLES: Record<ToastKind, ToastStyle> = {
  // A failure that closes itself is a failure the user can miss while reading something else.
  error: { color: 'red', loading: false, autoClose: false, role: 'alert' },
  success: { color: 'green', loading: false, autoClose: AUTO_CLOSE_MS, role: 'status' },
  loading: { loading: true, autoClose: false, role: 'status' },
};

const emit = (kind: ToastKind, { id, messageKey, values }: NotificationRequest): void => {
  const style = STYLES[kind];
  const payload = {
    id,
    message: <ToastMessage messageKey={messageKey} {...(values === undefined ? {} : { values })} />,
    // Spread rather than `color: style.color`: a loading toast has no colour of its own, and
    // `color: undefined` is not the same as «no colour» under `exactOptionalPropertyTypes`.
    ...(style.color === undefined ? {} : { color: style.color }),
    loading: style.loading,
    autoClose: style.autoClose,
    role: style.role,
    'aria-live': style.role === 'alert' ? ('assertive' as const) : ('polite' as const),
  };

  if (live.has(id)) {
    notifications.update(payload);
    return;
  }

  live.add(id);
  notifications.show({
    ...payload,
    onClose: () => {
      live.delete(id);
    },
  });
};

export const notify = {
  error: (request: NotificationRequest) => {
    emit('error', request);
  },
  success: (request: NotificationRequest) => {
    emit('success', request);
  },
  /** For an operation long enough that silence reads as «nothing happened» (§7). */
  loading: (request: NotificationRequest) => {
    emit('loading', request);
  },
  dismiss: (id: string) => {
    notifications.hide(id);
    live.delete(id);
  },
  /** Everything at once — a route change that invalidates what the toasts were about, and tests. */
  clear: () => {
    notifications.clean();
    live.clear();
  },
} as const satisfies NotificationPort & Record<string, unknown>;
