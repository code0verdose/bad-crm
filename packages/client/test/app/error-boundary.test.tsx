import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppErrorBoundary } from '@app/ui/app-error-boundary.component.js';
import { installGlobalErrorListeners } from '@app/global-error-listeners.util.js';

/**
 * The screen a person sees when the part of the application that renders screens is the part that
 * broke.
 *
 * The route boundary handles a loader or a component inside the route tree; this one exists for
 * everything above it — a provider, the session bootstrap, the router itself. Without it the answer
 * to «the shell threw» is a white page, which tells the user nothing and the team even less.
 *
 * React writes a caught error to `console.error` no matter what the boundary does. That is noise in
 * a suite whose whole point is that the error was *handled*, so it is silenced per case rather than
 * globally — a suite that hides `console.error` everywhere also hides the ones nobody handled.
 */
const Throwing = (): never => {
  throw new Error('the shell broke');
};

const renderBoundary = (report: (error: unknown, id: string) => void) =>
  render(
    <MantineProvider env="test">
      <AppErrorBoundary report={report}>
        <Throwing />
      </AppErrorBoundary>
    </MantineProvider>,
  );

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the global error boundary', () => {
  it('shows a recovery screen instead of a blank page', () => {
    renderBoundary(vi.fn());

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('errors.app.title');
  });

  /**
   * The way out. A boundary above the router cannot re-run a loader — the router is what broke — so
   * the only honest offer is a reload, and it has to be a real button rather than a sentence asking
   * the user to press F5.
   */
  it('offers a way out that a keyboard can reach', async () => {
    const user = userEvent.setup();
    renderBoundary(vi.fn());

    await user.tab();

    expect(screen.getByRole('button', { name: 'errors.app.reload' })).toHaveFocus();
  });

  /**
   * The identifier is what turns «it broke» into a support conversation: the person reads it out,
   * and the same value is in the report the team received.
   */
  it('shows an identifier and sends the same one with the report', () => {
    const report = vi.fn();

    renderBoundary(report);

    const shown = screen.getByTestId('app-error-reference').textContent ?? '';

    expect(shown).not.toBe('');
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[1]).toBe(shown);
  });

  it('reports the error it caught, not a summary of it', () => {
    const report = vi.fn();

    renderBoundary(report);

    expect((report.mock.calls[0]?.[0] as Error).message).toBe('the shell broke');
  });

  /**
   * The button has to actually do the one thing it offers. `location.reload` is not implemented in
   * jsdom, so it is replaced for the case rather than spied on — a spy on a method that throws when
   * called proves nothing.
   */
  it('reloads the page when asked to', async () => {
    const user = userEvent.setup();
    const reload = vi.fn();
    // Restored key by key rather than with `vi.unstubAllGlobals()`, which removes **every** stub in
    // the worker — including the `matchMedia` the suite setup installs for Mantine. The first
    // version of this case used it and the next test in the file died in `MantineProvider`.
    const realLocation = globalThis.location;
    vi.stubGlobal('location', { ...realLocation, reload });

    try {
      renderBoundary(vi.fn());
      await user.click(screen.getByRole('button', { name: 'errors.app.reload' }));

      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      vi.stubGlobal('location', realLocation);
    }
  });

  /** CONTROL: a subtree that does not throw is rendered, not replaced by the recovery screen. */
  it('CONTROL: leaves a working subtree alone', () => {
    render(
      <MantineProvider env="test">
        <AppErrorBoundary report={vi.fn()}>
          <p>the application</p>
        </AppErrorBoundary>
      </MantineProvider>,
    );

    expect(screen.getByText('the application')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });
});

/**
 * A rejected promise nobody awaited never reaches a boundary — React does not see it, and the
 * default browser behaviour is a console line the team never reads. It is the same class of failure
 * and goes to the same place.
 */
describe('global listeners', () => {
  it('reports an unhandled rejection', () => {
    const report = vi.fn();
    const uninstall = installGlobalErrorListeners({ report });

    try {
      const reason = new Error('nobody awaited this');
      // `promise` is a resolved one on purpose. The listener reads `reason` and nothing else, and a
      // real `Promise.reject` here would be an unhandled rejection of its own — which Vitest reports
      // and fails the run for, as it did on the first version of this case. A test about unhandled
      // rejections should not create one.
      window.dispatchEvent(
        Object.assign(new Event('unhandledrejection'), { reason, promise: Promise.resolve() }),
      );

      expect(report).toHaveBeenCalledWith(reason, expect.any(String));
    } finally {
      uninstall();
    }
  });

  /**
   * CONTROL: the listener has to come off again. A test that installed one and left it behind would
   * make the next file in this worker report its own deliberate rejections.
   */
  it('CONTROL: stops reporting once uninstalled', () => {
    const report = vi.fn();

    installGlobalErrorListeners({ report })();
    window.dispatchEvent(
      Object.assign(new Event('unhandledrejection'), {
        reason: new Error('after uninstall'),
        promise: Promise.resolve(),
      }),
    );

    expect(report).not.toHaveBeenCalled();
  });
});
