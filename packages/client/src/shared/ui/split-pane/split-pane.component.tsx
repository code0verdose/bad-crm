import { Box } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import classes from './split-pane.module.css';

/** How far the first panel may shrink or grow, in percent of the container. */
const MIN = 20;
const MAX = 80;
const STEP = 2;
const PAGE_STEP = 10;

export interface SplitPaneProps {
  /** i18n key naming what the divider adjusts; it is the accessible name of the separator. */
  readonly labelKey: string;
  /** Where the position is remembered. One key per split, so two splits do not share a width. */
  readonly storageKey: string;
  readonly first: ReactNode;
  readonly second: ReactNode;
}

const clamp = (value: number): number => Math.min(MAX, Math.max(MIN, Math.round(value)));

/**
 * Two panels and a divider the user can move — with a keyboard as well as with a pointer.
 *
 * **The keyboard is not the fallback, it is the specification.** A divider that only answers to
 * dragging does not exist for anybody who does not drag, and there is no way to announce «drag me».
 * So the element carries `role="separator"`, is focusable, reports its position through
 * `aria-valuenow`, and moves with the arrows — small steps, larger ones on `PageUp`/`PageDown`, and
 * straight to the bounds with `Home`/`End`, which is the pattern the WAI-ARIA window splitter
 * describes (`rules/a11y.mdc`).
 *
 * **The bounds are load-bearing.** A panel dragged to zero is not a narrow panel; it is content that
 * vanished together with the handle that would bring it back. `MIN`/`MAX` make that unreachable from
 * either input.
 *
 * **A `button` carrying `role="separator"`.** The role is what assistive technology reads; the
 * element is what the browser gives focus and key events to for free. A `div` would need
 * `tabIndex={0}` and would still be a non-interactive element with keyboard handlers — which is what
 * `jsx-a11y` objects to, and it objects correctly: the pattern only works because something makes the
 * element focusable, and a native control is the honest way to say so.
 *
 * **The position is remembered** through `useLocalStorage`, the same hook the sidebar and the density
 * use. No wrapper of our own: it already is the persisted-state hook, and wrapping a Mantine hook that
 * needs nothing added is what `rules/design-system.mdc` §7 forbids.
 */
export function SplitPane({ labelKey, storageKey, first, second }: SplitPaneProps) {
  const { t } = useTranslation();

  const [size, setSize] = useLocalStorage<number>({
    key: storageKey,
    defaultValue: 50,
    getInitialValueInEffect: false,
  });
  const rootRef = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const next = {
      ArrowLeft: size - STEP,
      ArrowRight: size + STEP,
      PageDown: size - PAGE_STEP,
      PageUp: size + PAGE_STEP,
      Home: MIN,
      End: MAX,
    }[event.key];

    if (next === undefined) return;

    // Only once the key is one we act on: a container that swallows every key would break `Tab`
    // out of the splitter, which is the way a keyboard user leaves it.
    event.preventDefault();
    setSize(clamp(next));
  };

  const onPointerMove = (event: PointerEvent<HTMLButtonElement>): void => {
    const bounds = rootRef.current?.getBoundingClientRect();

    if (bounds === undefined || bounds.width === 0) return;

    setSize(clamp(((event.clientX - bounds.left) / bounds.width) * 100));
  };

  return (
    // `Box` with `__vars` rather than a `style` prop on a `div`: the value is per instance and
    // changes on every arrow key, so it cannot live in the stylesheet — but `react/forbid-dom-props`
    // bans inline styles on DOM nodes, and it is right to. Mantine's typed escape hatch keeps the
    // layout itself in the CSS module, which reads `var(--bc-split-size)` and knows nothing else.
    <Box className={classes['root']} ref={rootRef} __vars={{ '--bc-split-size': `${size}%` }}>
      <div className={classes['panel']}>{first}</div>
      <button
        aria-label={t(labelKey)}
        aria-valuemax={MAX}
        aria-valuemin={MIN}
        aria-valuenow={size}
        className={classes['divider']}
        onKeyDown={onKeyDown}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) onPointerMove(event);
        }}
        onPointerUp={(event) => {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        role="separator"
        type="button"
      />
      <div className={classes['panel']}>{second}</div>
    </Box>
  );
}
