import { useInterval } from '@mantine/hooks';
import { useState } from 'react';

/**
 * Whole seconds left until a deadline, re-rendered once a second while there are any.
 *
 * Non-domain by construction — it knows a number and the clock — so it lives in `shared`
 * (`rules/frontend-fsd.mdc` rule 8). The sign-in's second-factor step is its first caller: the
 * intermediate token lives five minutes and the screen has to say so, because a code typed into a
 * step that quietly died reads as a wrong code.
 *
 * **A deadline rather than a duration.** `POST /auth/login` reports `expiresIn` seconds, which is
 * the right thing for it to report — a duration cannot be wrong about the clock on the reader's
 * machine — and the caller turns it into an instant once, when the answer arrives. Counting a
 * duration down by subtracting one per tick would drift with every missed timer, and a background
 * tab misses a great many.
 *
 * **`useInterval` from `@mantine/hooks`, not a hand-rolled `useEffect`.** It keeps the callback in a
 * ref and clears the timer on unmount, which is the whole of what the effect would have to do
 * correctly (`rules/frontend-fsd.mdc` rule 11 asks for a real side effect with cleanup; this is the
 * library's). The MCP index for this workspace serves components only — the hook's contract was
 * read from the installed typings of `@mantine/hooks@9.5.0`.
 *
 * **The clock is only read while reading it changes the answer.** With no deadline, and after the
 * deadline has passed, the tick is a no-op and nothing re-renders — but the pass that crosses the
 * deadline does render, and it renders zero. That final render is the one the caller acts on;
 * stopping one beat earlier is how a countdown freezes at «1 s» and leaves a dead step on screen.
 */
export const useSecondsRemaining = (deadline: number | null): number | null => {
  const [, setLastTick] = useState(() => Date.now());

  // Read at render rather than from the tick that woke it. The state exists to *cause* the render;
  // if it also supplied the number, every answer would be as old as the last tick — and the first
  // one would be as old as the mount, which is how a five-minute deadline set a second ago reports
  // 301 seconds.
  const remaining =
    deadline === null ? null : Math.max(0, Math.ceil((deadline - Date.now()) / 1_000));

  useInterval(
    () => {
      if (remaining !== null && remaining > 0) setLastTick(Date.now());
    },
    1_000,
    { autoInvoke: true },
  );

  return remaining;
};
