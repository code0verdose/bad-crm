import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useRemovalFocusHandoff } from './use-removal-focus-handoff.hook.js';

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

const setup = () => {
  const anchor = document.createElement('input');
  const control = document.createElement('select');

  document.body.append(anchor, control);
  const { result } = renderHook(() => useRemovalFocusHandoff({ current: anchor }));

  return { anchor, control, attach: result.current };
};

afterEach(() => {
  document.body.replaceChildren();
});

describe('useRemovalFocusHandoff', () => {
  it('moves focus to the anchor when the focused control leaves the page', async () => {
    const { anchor, control, attach } = setup();
    const cleanup = attach(control);

    control.focus();
    cleanup();
    control.remove();
    await flush();

    expect(document.activeElement).toBe(anchor);
  });

  it('leaves focus alone when the ref is only re-attached and the control stays', async () => {
    const { control, attach } = setup();
    const cleanup = attach(control);

    control.focus();
    cleanup();
    attach(control);
    await flush();

    expect(document.activeElement).toBe(control);
  });

  it('does nothing for a control that did not hold focus', async () => {
    const { anchor, control, attach } = setup();
    const cleanup = attach(control);

    cleanup();
    control.remove();
    await flush();

    expect(document.activeElement).not.toBe(anchor);
  });
});
