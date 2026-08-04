# VelocityMarquee — ported from React Bits (ScrollVelocity)

- Upstream: <https://reactbits.dev/text-animations/scroll-velocity> (`ScrollVelocity-TS-CSS`)
- Repository: <https://github.com/DavidHDev/react-bits>, `src/content/TextAnimations/ScrollVelocity/ScrollVelocity.tsx`
- Licence: MIT © David Haz. Recorded in the repository [`NOTICE`](../../../../../../../NOTICE).

## What changed in the port

- Only the row is ported. Upstream's outer component maps over an array of texts and — the part that
  had to go — **declares the row component inside its own body**, so every render of the parent
  creates a new component type and remounts the whole marquee.
- The copy width is measured with a `ResizeObserver` instead of a `resize` listener: the row also
  changes width when the font loads or the language switches, and neither of those resizes the
  window.
- Reduced motion renders a single static copy. An endless horizontal crawl is the clearest case of
  what that setting is for.
- The upstream typography (`font-size: 5rem`, `sans-serif`, a drop shadow) is not part of the port —
  the caller styles the content.
