# CountUp — ported from React Bits

- Upstream: <https://reactbits.dev/text-animations/count-up> (`CountUp-TS-CSS`)
- Repository: <https://github.com/DavidHDev/react-bits>, `src/content/TextAnimations/CountUp/CountUp.tsx`
- Licence: MIT © David Haz. Recorded in the repository [`NOTICE`](../../../../../../../NOTICE).

## What changed in the port

- Default export → named export; kebab-case filename with a role suffix.
- The decimal-detection block is gone: every number on this page is an integer, and the upstream
  helper parsed `toString()` output to find fraction digits.
- The locale is a prop instead of a hard-coded `'en-US'`, so a Russian visitor sees Russian
  grouping.
- Reduced motion prints the final value immediately rather than springing to it.
- `direction`, `separator`, `onStart` and `onEnd` are dropped — unused options are code nobody
  maintains.
