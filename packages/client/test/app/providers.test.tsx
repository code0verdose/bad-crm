import { useMutation } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Providers } from '@app/providers.js';
import { installStyleNonce, styleNonce } from '@app/style-nonce.util.js';
import { SharedApi, SharedUi } from '@shared';

/**
 * The two seams the shell had to close, tested where they meet rather than in isolation.
 *
 * 1. A mutation failing inside the real provider tree produces exactly **one** toast, and the same
 *    failure repeated updates it instead of stacking (`rules/errors-and-toasts.mdc` §2, §6). Until
 *    this file existed the port passed to `createAppQueryClient` was `silentNotifications`, so the
 *    whole path was green with nothing visible on screen.
 * 2. The `<style>` nonce is read from the document rather than baked into the bundle (ADR-0023).
 */

const failingClient = () =>
  SharedApi.createAppQueryClient({ notify: SharedUi.notify, logError: vi.fn() });

/** A component may not call `useMutation` (ESLint enforces it); a test harness is not a component. */
const FailingButton = ({ onError }: { readonly onError?: () => void }) => {
  const mutation = useMutation({
    mutationFn: () => Promise.reject(new Error('network is down')),
    ...(onError === undefined ? {} : { onError }),
  });

  return (
    <button onClick={() => mutation.mutate()} type="button">
      save
    </button>
  );
};

afterEach(() => {
  SharedUi.notify.clear();
});

describe('a mutation that fails inside the provider tree', () => {
  it('shows exactly one toast', async () => {
    const user = userEvent.setup();
    render(
      <Providers queryClient={failingClient()}>
        <FailingButton />
      </Providers>,
    );

    await user.click(screen.getByRole('button', { name: 'save' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('does not stack a second toast when the same failure repeats', async () => {
    const user = userEvent.setup();
    render(
      <Providers queryClient={failingClient()}>
        <FailingButton />
      </Providers>,
    );

    const save = screen.getByRole('button', { name: 'save' });
    await user.click(save);
    await screen.findByRole('alert');
    await user.click(save);
    await user.click(save);

    await waitFor(() => {
      expect(screen.getAllByRole('alert')).toHaveLength(1);
    });
  });

  /**
   * The local handler *overrides* the global one rather than adding to it — otherwise one refusal
   * produces two toasts, which is the failure mode §3 of the rule is written against.
   */
  it('stays silent when the mutation handles its own failure', async () => {
    const user = userEvent.setup();
    const onError = vi.fn();
    render(
      <Providers queryClient={failingClient()}>
        <FailingButton onError={onError} />
      </Providers>,
    );

    await user.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() => {
      expect(onError).toHaveBeenCalledOnce();
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('the style nonce', () => {
  afterEach(() => {
    document.head.querySelector('meta[name="csp-nonce"]')?.remove();
  });

  it('is undefined when the document carries no nonce, so no attribute is written', () => {
    expect(styleNonce()).toBeUndefined();
  });

  it('is read from the meta tag the serving process injects', () => {
    document.head.insertAdjacentHTML(
      'beforeend',
      '<meta name="csp-nonce" content="8IBTHwOdqNKAWeKl7plt8g==">',
    );

    expect(styleNonce()).toBe('8IBTHwOdqNKAWeKl7plt8g==');
  });

  it('treats an empty nonce as absent — an empty attribute would block the very style it allows', () => {
    document.head.insertAdjacentHTML('beforeend', '<meta name="csp-nonce" content="  ">');

    expect(styleNonce()).toBeUndefined();
  });

  /**
   * The second style injector, and the one Mantine does not own. Measured in a browser under the
   * real policy: opening the drawer produced a `style-src-elem` violation, because
   * `react-remove-scroll` writes its scroll-lock `<style>` itself and finds its nonce on the
   * global that `get-nonce` reads.
   */
  it('publishes the nonce to the scroll-lock style injector', () => {
    document.head.insertAdjacentHTML(
      'beforeend',
      '<meta name="csp-nonce" content="8IBTHwOdqNKAWeKl7plt8g==">',
    );

    expect(installStyleNonce()).toBe('8IBTHwOdqNKAWeKl7plt8g==');
    expect((globalThis as unknown as Record<string, string>)['__webpack_nonce__']).toBe(
      '8IBTHwOdqNKAWeKl7plt8g==',
    );
  });

  it('publishes nothing when the document carries no nonce', () => {
    Reflect.deleteProperty(globalThis, '__webpack_nonce__');

    expect(installStyleNonce()).toBeUndefined();
    expect((globalThis as unknown as Record<string, string>)['__webpack_nonce__']).toBeUndefined();
  });

  /**
   * The measured failure of ADR-0023: under `style-src-elem 'self' 'nonce-…'` the provider's
   * `<style>` element is blocked without the attribute, the page renders, and only the theme
   * variables are missing — a green suite over a broken layout. So the assertion is on the
   * attribute of the element Mantine actually wrote.
   */
  it('puts the nonce on the style element Mantine writes', async () => {
    document.head.insertAdjacentHTML(
      'beforeend',
      '<meta name="csp-nonce" content="8IBTHwOdqNKAWeKl7plt8g==">',
    );

    render(
      <Providers queryClient={failingClient()}>
        <p>content</p>
      </Providers>,
    );

    await screen.findByText('content');

    const styles = [...document.querySelectorAll('style[data-mantine-styles]')];
    expect(styles.length).toBeGreaterThan(0);
    expect(
      styles.every((style) => style.getAttribute('nonce') === '8IBTHwOdqNKAWeKl7plt8g=='),
    ).toBe(true);
  });
});
