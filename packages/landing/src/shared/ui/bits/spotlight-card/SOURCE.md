# SpotlightCard — ported from React Bits

- Upstream: <https://reactbits.dev/components/spotlight-card> (`SpotlightCard-TS-CSS`)
- Repository: <https://github.com/DavidHDev/react-bits>, `src/content/Components/SpotlightCard/SpotlightCard.tsx`
- Licence: MIT © David Haz. Recorded in the repository [`NOTICE`](../../../../../../../NOTICE).

## What changed in the port

- Default export → named export; kebab-case filename with a role suffix.
- The card's own look (radius, border, background, padding) is gone: upstream ships a finished dark
  card, this one is a transparent surface that takes its skin from the section using it. Only the
  spotlight belongs here.
- The spotlight colour is a token (`--bcl-glow`) instead of a `rgba(...)` prop, so light and dark
  schemes do not each need their own call site.
- Pointer coordinates are written as percentages of the box rather than pixels, so a resize between
  two pointer moves cannot leave the highlight in the wrong place.
- The `mousemove` handler is skipped entirely when the device has no fine pointer.
