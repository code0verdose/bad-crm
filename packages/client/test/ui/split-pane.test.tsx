import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { type ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { SharedUi } from '@shared';

/**
 * A resizable split, and the half of it that is not the dragging.
 *
 * A separator that only responds to a pointer is a separator that does not exist for anybody using a
 * keyboard, and «drag me» is not a thing a screen reader can announce. So the assertions here are
 * about the parts that are usually left out: the role and the value it reports, the arrow keys, the
 * bounds, and the fact that the answer survives a reload — a person who narrowed a panel has said
 * something about how they work, and asking again next time is the product forgetting it.
 *
 * Pointer dragging is exercised too, but it is the least interesting property: if the keyboard path
 * and the persisted value are right, the pointer is one more way to reach the same setter.
 */
const KEY = 'bc-split-test';

const renderPane = (children?: ReactNode) =>
  render(
    <MantineProvider env="test">
      <SharedUi.SplitPane
        labelKey="common.loading"
        storageKey={KEY}
        first={<p>left</p>}
        second={children ?? <p>right</p>}
      />
    </MantineProvider>,
  );

afterEach(() => {
  localStorage.clear();
});

describe('SplitPane', () => {
  it('CONTROL: renders both panels', () => {
    renderPane();

    expect(screen.getByText('left')).toBeInTheDocument();
    expect(screen.getByText('right')).toBeInTheDocument();
  });

  it('exposes the divider as a separator that reports where it is', () => {
    renderPane();

    const separator = screen.getByRole('separator', { name: 'common.loading' });

    expect(separator).toHaveAttribute('aria-valuenow', '50');
    expect(separator).toHaveAttribute('aria-valuemin', '20');
    expect(separator).toHaveAttribute('aria-valuemax', '80');
    // Focusable, or the arrow keys below are unreachable. Asserted by focusing it rather than by
    // looking for `tabindex`: the element is a native `button`, so it is focusable *without* the
    // attribute — and an assertion on the attribute would fail while the behaviour was correct.
    separator.focus();
    expect(document.activeElement).toBe(separator);
  });

  it.each([
    ['{ArrowRight}', 52],
    ['{ArrowLeft}', 48],
  ])('moves with %s', async (key, expected) => {
    const user = userEvent.setup();
    renderPane();
    const separator = screen.getByRole('separator', { name: 'common.loading' });

    separator.focus();
    await user.keyboard(key);

    expect(separator).toHaveAttribute('aria-valuenow', String(expected));
  });

  it('jumps by a larger step with Page keys, and to the bounds with Home and End', async () => {
    const user = userEvent.setup();
    renderPane();
    const separator = screen.getByRole('separator', { name: 'common.loading' });
    separator.focus();

    await user.keyboard('{PageUp}');
    expect(separator).toHaveAttribute('aria-valuenow', '60');

    await user.keyboard('{Home}');
    expect(separator).toHaveAttribute('aria-valuenow', '20');

    await user.keyboard('{End}');
    expect(separator).toHaveAttribute('aria-valuenow', '80');
  });

  /**
   * The bounds are what stop a panel from being dragged to nothing. A zero-width panel is not a
   * smaller panel — it is content that has disappeared with no way to bring it back, because the
   * handle for bringing it back is the thing that went to zero.
   */
  it('refuses to go past its own bounds', async () => {
    const user = userEvent.setup();
    renderPane();
    const separator = screen.getByRole('separator', { name: 'common.loading' });
    separator.focus();

    await user.keyboard('{Home}{ArrowLeft}{ArrowLeft}');
    expect(separator).toHaveAttribute('aria-valuenow', '20');

    await user.keyboard('{End}{ArrowRight}{ArrowRight}');
    expect(separator).toHaveAttribute('aria-valuenow', '80');
  });

  it('remembers where it was left, and starts there next time', async () => {
    const user = userEvent.setup();
    const first = renderPane();
    const separator = screen.getByRole('separator', { name: 'common.loading' });

    separator.focus();
    await user.keyboard('{PageUp}');
    first.unmount();

    renderPane();

    expect(screen.getByRole('separator', { name: 'common.loading' })).toHaveAttribute(
      'aria-valuenow',
      '60',
    );
  });

  /**
   * The pointer path, which the keyboard cases above deliberately do not exercise.
   *
   * jsdom lays nothing out, so `getBoundingClientRect` answers zeros for everything and the pointer
   * capture methods do not exist on elements. Both are supplied here — the geometry the component
   * would read from a real layout, and the capture calls it makes — because the arithmetic between
   * them is the part worth asserting: a clientX two thirds across a 300-pixel container is 66 %.
   */
  const draggableRoot = (): { separator: HTMLElement; root: HTMLElement } => {
    const separator = screen.getByRole('separator', { name: 'common.loading' });
    const root = separator.parentElement as HTMLElement;

    root.getBoundingClientRect = () => ({ left: 0, width: 300 }) as DOMRect;
    separator.setPointerCapture = () => undefined;
    separator.hasPointerCapture = () => true;

    return { separator, root };
  };

  it('follows the pointer while it is captured', () => {
    renderPane();
    const { separator } = draggableRoot();

    fireEvent.pointerDown(separator, { pointerId: 1 });
    fireEvent.pointerMove(separator, { pointerId: 1, clientX: 200 });

    expect(separator).toHaveAttribute('aria-valuenow', '67');
  });

  it('clamps a drag past the bounds instead of collapsing a panel', () => {
    renderPane();
    const { separator } = draggableRoot();

    fireEvent.pointerDown(separator, { pointerId: 1 });
    fireEvent.pointerMove(separator, { pointerId: 1, clientX: -400 });

    expect(separator).toHaveAttribute('aria-valuenow', '20');
  });

  it('ignores a move that is not part of a drag it captured', () => {
    renderPane();
    const separator = screen.getByRole('separator', { name: 'common.loading' });
    (separator.parentElement as HTMLElement).getBoundingClientRect = () =>
      ({ left: 0, width: 300 }) as DOMRect;
    separator.hasPointerCapture = () => false;

    fireEvent.pointerMove(separator, { pointerId: 1, clientX: 200 });

    expect(separator).toHaveAttribute('aria-valuenow', '50');
  });

  /**
   * A container that has not been laid out yet answers zero for its width, and dividing by it gives
   * `Infinity` — which `clamp` would turn into the maximum, snapping the panel wide on the first
   * stray event after mount. The guard is the reason that does not happen, so it is asserted.
   */
  it('ignores a drag before the container has a width', () => {
    renderPane();
    const separator = screen.getByRole('separator', { name: 'common.loading' });
    separator.setPointerCapture = () => undefined;
    separator.hasPointerCapture = () => true;

    fireEvent.pointerDown(separator, { pointerId: 1 });
    fireEvent.pointerMove(separator, { pointerId: 1, clientX: 200 });

    expect(separator).toHaveAttribute('aria-valuenow', '50');
  });

  it('releases the pointer when the drag ends', () => {
    renderPane();
    const { separator } = draggableRoot();
    let released = false;
    separator.releasePointerCapture = () => {
      released = true;
    };

    fireEvent.pointerDown(separator, { pointerId: 1 });
    fireEvent.pointerUp(separator, { pointerId: 1 });

    expect(released).toBe(true);
  });

  /**
   * Every other key belongs to the page, and `Tab` above all: it is how a keyboard user leaves the
   * splitter. A handler that called `preventDefault` before deciding whether the key was one of its
   * own would trap focus on the divider — a component that is *more* accessible on paper and
   * unusable in practice.
   */
  it('leaves keys it does not own to the page, so focus can move on', async () => {
    const user = userEvent.setup();
    renderPane();
    const separator = screen.getByRole('separator', { name: 'common.loading' });

    separator.focus();
    await user.keyboard('{Tab}');

    expect(separator).toHaveAttribute('aria-valuenow', '50');
    expect(document.activeElement).not.toBe(separator);
  });

  it('has no accessibility violation', async () => {
    const { container } = renderPane();

    const { violations } = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    });

    expect(violations.map((violation) => violation.id)).toEqual([]);
  });
});
