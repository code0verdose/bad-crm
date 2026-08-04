/**
 * The seam between the data layer and the design system.
 *
 * The global `MutationCache.onError` is the single source of a failure signal
 * (`rules/errors-and-toasts.mdc` §3), and it lives in `shared/api` — which must not import a
 * component, a theme or a vendor toast library. So it announces through this interface instead, and
 * whoever owns the screen provides the implementation: `shared/ui/toaster` over
 * `@mantine/notifications` once the design system lands (EPIC-007), and
 * `SharedLib.silentNotifications` until then.
 *
 * The shape is deliberately narrow. A notification carries a **key**, never text: the catalogue is
 * `errors.json` in both languages and the text is chosen at render time (`rules/i18n.mdc`). It
 * carries a stable **id** so that the same failure repeated updates one toast instead of stacking a
 * pile of identical ones (`rules/errors-and-toasts.mdc` §6).
 */
export interface NotificationRequest {
  /** Stable across repeats of the same signal, so the toaster updates rather than appends. */
  readonly id: string;
  /** i18n key, resolved by the presentation layer. Never a message. */
  readonly messageKey: string;
  /**
   * What the sentence interpolates, when it has a placeholder — the wait in a rate-limit message,
   * today. Values rather than a finished string: the number sits in a different place in each
   * language, so anything glued here is right in one of them at most.
   */
  readonly values?: Readonly<Record<string, string | number>>;
}

export interface NotificationPort {
  readonly error: (request: NotificationRequest) => void;
  readonly success: (request: NotificationRequest) => void;
}
