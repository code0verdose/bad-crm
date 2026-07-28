import { type AuthEvent } from '@units/auth/model';

export type AuthEventHandler = (event: AuthEvent) => void;

/**
 * A `Set`, so that unsubscribing twice is harmless.
 *
 * That is not a hypothetical: `StrictMode` mounts, unmounts and mounts again, so every effect
 * cleanup runs twice in development. With an array and an index-based removal, the second call would
 * delete whichever subscriber had moved into that slot — an unrelated listener going deaf, in
 * development only.
 */
const handlers = new Set<AuthEventHandler>();

export const onAuthEvent = (handler: AuthEventHandler): (() => void) => {
  handlers.add(handler);

  return () => {
    handlers.delete(handler);
  };
};

/**
 * Iterates a copy: a handler that unsubscribes itself while being notified would otherwise mutate
 * the set mid-iteration.
 */
export const emitAuthEvent = (event: AuthEvent): void => {
  for (const handler of [...handlers]) handler(event);
};
