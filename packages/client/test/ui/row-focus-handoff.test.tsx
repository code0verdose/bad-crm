import { MantineProvider } from '@mantine/core';
import { act, render, screen } from '@testing-library/react';
import { StrictMode, useCallback, useState } from 'react';
import { describe, expect, it } from 'vitest';

import { SharedUi } from '@shared';

/**
 * `useRowFocusHandoff` on its own, under `StrictMode` as the application mounts: the cases the
 * roster screen cannot stage — somebody else placing focus before the handoff runs, and a row that
 * leaves without having held focus.
 *
 * The screen-level behaviour (next row, row above, heading, the row a rollback returns) is proven
 * on the assembled members screen, `test/routes/project-members-screen.test.tsx`.
 */

const never = (): boolean => false;

function RemoveButton({ name, onRemove }: { name: string; onRemove: (name: string) => void }) {
  const ref = SharedUi.useRowFocusHandoff(never);

  return (
    <button
      data-row-action="remove"
      onClick={() => {
        onRemove(name);
      }}
      ref={ref}
      type="button"
    >
      {`remove ${name}`}
    </button>
  );
}

function Roster({ initial }: { initial: readonly string[] }) {
  const [rows, setRows] = useState(initial);
  const remove = useCallback((name: string) => {
    setRows((current) => current.filter((row) => row !== name));
  }, []);

  return (
    <>
      <SharedUi.Section titleKey="roster.title">
        <table>
          <tbody>
            {rows.map((name) => (
              <tr key={name}>
                <td>
                  <RemoveButton name={name} onRemove={remove} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </SharedUi.Section>
      <button type="button">elsewhere</button>
    </>
  );
}

const mount = (rows: readonly string[]) =>
  render(
    <StrictMode>
      <MantineProvider env="test">
        <Roster initial={rows} />
      </MantineProvider>
    </StrictMode>,
  );

/** Lets the microtask the handoff is queued on run. */
const settle = () => act(async () => Promise.resolve());

describe('useRowFocusHandoff', () => {
  it('does not take focus from where somebody else put it before the handoff ran', async () => {
    mount(['a', 'b']);

    const leaving = screen.getByRole('button', { name: 'remove a' });
    const elsewhere = screen.getByRole('button', { name: 'elsewhere' });

    leaving.focus();
    act(() => {
      leaving.click();
    });
    // Same tick as the removal, before the queued handoff: a dialog opening, say.
    elsewhere.focus();
    await settle();

    expect(elsewhere).toHaveFocus();
  });

  it('moves nothing when the row that leaves did not hold focus', async () => {
    mount(['a', 'b']);

    const elsewhere = screen.getByRole('button', { name: 'elsewhere' });

    elsewhere.focus();
    act(() => {
      screen.getByRole('button', { name: 'remove a' }).click();
    });
    await settle();

    expect(elsewhere).toHaveFocus();
  });

  it('leaves focus on the page when a row that did not hold it leaves', async () => {
    mount(['a', 'b']);

    (document.activeElement as HTMLElement | null)?.blur();
    act(() => {
      screen.getByRole('button', { name: 'remove a' }).click();
    });
    await settle();

    expect(document.body).toHaveFocus();
  });

  it('hands focus on when the row that held it leaves', async () => {
    mount(['a', 'b']);

    const leaving = screen.getByRole('button', { name: 'remove a' });

    leaving.focus();
    act(() => {
      leaving.click();
    });
    await settle();

    expect(screen.getByRole('button', { name: 'remove b' })).toHaveFocus();
  });

  it('keeps focus on a row that re-renders in place', async () => {
    mount(['a', 'b']);

    const staying = screen.getByRole('button', { name: 'remove a' });

    staying.focus();
    // The other row leaves; this one's node stays and keeps its ref.
    act(() => {
      screen.getByRole('button', { name: 'remove b' }).click();
    });
    await settle();

    expect(staying).toHaveFocus();
  });
});
