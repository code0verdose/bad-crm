import { lazy, Suspense } from 'react';

import { useMediaQuery } from '@/shared/lib/use-media-query.hook.js';
import { useReducedMotion } from '@/shared/lib/use-reduced-motion.hook.js';

/**
 * The gate in front of the shader, and the only thing the page imports.
 *
 * Three decisions live here so that no section has to remember them:
 *
 * - **Code split.** OGL plus the shader is the largest thing on the page and it decorates one
 *   section. `lazy` keeps it out of the initial chunk, which is what the `size-limit` budget in
 *   `package.json` is measuring.
 * - **Reduced motion.** A drifting aurora is exactly the movement that setting is about, so it is
 *   never mounted — not faded, not paused. The section behind it has its own static gradient.
 * - **Small screens.** A phone gets the gradient too: a full-viewport WebGL surface is the most
 *   expensive thing on the page and the least visible one there.
 */
const Aurora = lazy(async () => {
  const module = await import('./aurora.component.js');
  return { default: module.Aurora };
});

const WIDE_ENOUGH = '(min-width: 48em)';

export const AuroraBackdrop = ({
  colorStops,
}: {
  colorStops: readonly [string, string, string];
}) => {
  const reduced = useReducedMotion();
  const wide = useMediaQuery(WIDE_ENOUGH);

  if (reduced || !wide) return null;

  return (
    <Suspense fallback={null}>
      <Aurora colorStops={colorStops} amplitude={0.9} blend={0.6} speed={0.35} />
    </Suspense>
  );
};
