export interface GlobalErrorListenerOptions {
  readonly report: (error: unknown, reference: string) => void;
}

/**
 * A short identifier a person can read out loud and the team can search for.
 *
 * Eight characters rather than a full UUID: it exists to be dictated over a chat or a phone, and a
 * value nobody can transcribe is a value nobody reports. Collisions do not matter — it identifies
 * one occurrence within one support conversation, not a row in a table.
 */
export const errorReference = (): string =>
  globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 8);

/**
 * The failures no boundary can catch.
 *
 * A rejected promise nobody awaited never reaches React: the component tree did not throw, so no
 * boundary is entered and the default behaviour is a console line the team never reads. It is the
 * same class of failure as a render error and belongs in the same place, so it is routed through
 * the same reporter.
 *
 * Returns its own uninstall. A listener on `window` outlives every tree that installed it, and a
 * test that left one behind would make the next file report its own deliberate rejections.
 */
export const installGlobalErrorListeners = ({
  report,
}: GlobalErrorListenerOptions): (() => void) => {
  const onRejection = (event: Event): void => {
    report((event as PromiseRejectionEvent).reason, errorReference());
  };

  globalThis.addEventListener('unhandledrejection', onRejection);

  return () => {
    globalThis.removeEventListener('unhandledrejection', onRejection);
  };
};
