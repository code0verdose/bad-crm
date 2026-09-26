import { act, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { describe, expect, it } from 'vitest';

import { SharedHooks } from '@shared';

/**
 * Where focus goes when the control holding it takes itself off the page.
 *
 * The case it exists for is a «reset filters» button: pressing it removes the filters, and with them
 * the button. A focused node that leaves the document hands focus to `<body>`, and a keyboard or
 * screen reader user is thrown to the top with no word about where they are. The hook moves focus
 * to an anchor the caller names — something that is always on the screen.
 *
 * Mounted through a real component rather than by calling the returned function, because the
 * contract is React's: the cleanup a ref callback returns runs while the node is still in the
 * document, and that is the moment focus can still be read off it.
 */
interface HarnessProps {
  readonly anchored?: boolean;
}

function Harness({ anchored = true }: HarnessProps) {
  const anchor = useRef<HTMLInputElement>(null);
  const [shown, setShown] = useState(true);
  const handoff = SharedHooks.useFocusHandoff(anchor);

  return (
    <>
      {anchored && <input aria-label="anchor" ref={anchor} />}
      <button
        onClick={() => {
          setShown(false);
        }}
        type="button"
      >
        other
      </button>
      {shown && (
        <button
          onClick={() => {
            setShown(false);
          }}
          ref={handoff}
          type="button"
        >
          leaving
        </button>
      )}
    </>
  );
}

describe('the focus handoff', () => {
  it('moves focus to the anchor when the focused control leaves the page', () => {
    render(<Harness />);
    const leaving = screen.getByRole('button', { name: 'leaving' });

    act(() => {
      leaving.focus();
    });
    act(() => {
      leaving.click();
    });

    expect(screen.queryByRole('button', { name: 'leaving' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText('anchor'));
  });

  it('leaves focus alone when the control that left did not hold it', () => {
    render(<Harness />);
    const other = screen.getByRole('button', { name: 'other' });

    act(() => {
      other.focus();
    });
    act(() => {
      other.click();
    });

    expect(screen.queryByRole('button', { name: 'leaving' })).toBeNull();
    expect(document.activeElement).toBe(other);
  });

  it('does nothing, rather than throwing, when the anchor is not on the page', () => {
    render(<Harness anchored={false} />);
    const leaving = screen.getByRole('button', { name: 'leaving' });

    act(() => {
      leaving.focus();
    });
    act(() => {
      leaving.click();
    });

    expect(screen.queryByRole('button', { name: 'leaving' })).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });
});
