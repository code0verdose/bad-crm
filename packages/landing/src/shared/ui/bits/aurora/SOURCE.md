# Aurora — ported from React Bits

- Upstream: <https://reactbits.dev/backgrounds/aurora> (`Aurora-TS-CSS`)
- Repository: <https://github.com/DavidHDev/react-bits>, `src/content/Backgrounds/Aurora/Aurora.tsx`
- Licence: MIT © David Haz. Recorded in the repository [`NOTICE`](../../../../../../../NOTICE).

## What changed in the port

- Default export → named export, and the file renamed to this repository's convention.
- `./Aurora.css` → a CSS module; the container is `position: absolute` here because it is always a
  background layer behind a section, never a standalone block.
- Strict TypeScript: the upstream `props.uniforms.…` accesses rely on `any` from OGL's loose typing;
  the uniform record is typed locally instead, and `program` is non-null inside the closure that
  creates it rather than re-checked on every frame.
- The effect no longer re-reads props through a ref on every frame. Colour stops are converted once
  per change, which is what a background that never changes its palette actually needs.
- Mounted only when `prefers-reduced-motion` is not set and the viewport is wide enough — the
  decision lives in `aurora-backdrop.component.tsx`, which also code-splits the OGL import so the
  shader is not in the initial chunk.
