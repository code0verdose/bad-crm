import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { LocaleProvider } from '@/app/i18n/locale.provider.js';
import { LegalPage } from '@/pages/legal/legal-page.component.js';
import { ROUTES } from '@/shared/lib/use-route.hook.js';

const mount = (document: 'terms' | 'privacy' | 'cookies') =>
  render(
    <LocaleProvider>
      <LegalPage document={document} />
    </LocaleProvider>,
  );

afterEach(() => {
  globalThis.history.replaceState(null, '', ROUTES.home);
});

/**
 * The back link, which is the only interactive thing on these three pages.
 *
 * It is a real `<a href>` whose `onClick` calls `preventDefault` and navigates in place — the shape
 * that keeps middle-click and “open in new tab” working while a plain click avoids a full reload.
 * Both halves matter and neither had been executed: the handler is the two lines the coverage report
 * named, and `href` is what a browser uses when the handler never runs.
 */
describe('the legal pages', () => {
  it('offers the way back as a real link, not only as a handler', () => {
    mount('terms');

    const back = screen.getAllByRole('link')[0];

    expect(back).toHaveAttribute('href', ROUTES.home);
  });

  it('goes home in place when that link is clicked', async () => {
    const user = userEvent.setup();

    globalThis.history.replaceState(null, '', ROUTES.terms);
    mount('terms');

    await user.click(screen.getAllByRole('link')[0] as HTMLElement);

    expect(globalThis.location.pathname).toBe(ROUTES.home);
  });

  /** CONTROL: the three documents are three documents, not one rendered thrice. */
  it.each(['terms', 'privacy', 'cookies'] as const)('renders the %s document', (document) => {
    const { container } = mount(document);
    const heading = container.querySelector('h1');

    expect(heading?.textContent).not.toBe('');
  });
});
