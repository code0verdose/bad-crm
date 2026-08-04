import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EN_COPY } from '@/app/i18n/dictionary-en.constant.js';
import { LocaleProvider } from '@/app/i18n/locale.provider.js';
import { FeedbackForm } from '@/sections/cta/feedback-form.component.js';

/**
 * The form has no backend: submitting composes a `mailto:` link and hands it to the OS, and the
 * fields never leave the browser. `location.href =` is a real navigation as far as the DOM is
 * concerned, and jsdom does not implement navigation — so `location` is swapped for a plain object
 * for the length of each test, the same way `cookie-banner.widget.test.tsx` does it for `reload`.
 */
describe('the feedback form composes a mailto link', () => {
  const originalLocation = globalThis.location;

  beforeEach(() => {
    Object.defineProperty(globalThis, 'location', {
      value: { ...originalLocation, href: '' },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    });
  });

  it('encodes the subject and body and points at the contact address', async () => {
    render(
      <LocaleProvider>
        <FeedbackForm />
      </LocaleProvider>,
    );

    await userEvent.type(screen.getByLabelText(EN_COPY.cta.form.nameLabel), 'Nina');
    await userEvent.type(screen.getByLabelText(EN_COPY.cta.form.emailLabel), 'nina@example.com');
    await userEvent.type(
      screen.getByLabelText(EN_COPY.cta.form.messageLabel),
      'We are 11 people & need this by Friday.',
    );
    await userEvent.click(screen.getByRole('button', { name: EN_COPY.cta.form.submit }));

    const href = globalThis.location.href;
    expect(href).toMatch(/^mailto:hello@badcrm\.dev\?subject=.+&body=.+$/);

    const url = new URL(href);
    expect(url.protocol).toBe('mailto:');
    expect(url.pathname).toBe('hello@badcrm.dev');
    expect(decodeURIComponent(url.searchParams.get('subject') ?? '')).toBe('Bad CRM — Nina');
    expect(decodeURIComponent(url.searchParams.get('body') ?? '')).toBe(
      'We are 11 people & need this by Friday.\n\n— Nina\nnina@example.com',
    );
  });

  it('falls back to the email as the subject line when no name was given', async () => {
    render(
      <LocaleProvider>
        <FeedbackForm />
      </LocaleProvider>,
    );

    await userEvent.type(screen.getByLabelText(EN_COPY.cta.form.emailLabel), 'nina@example.com');
    await userEvent.type(screen.getByLabelText(EN_COPY.cta.form.messageLabel), 'Hello.');
    await userEvent.click(screen.getByRole('button', { name: EN_COPY.cta.form.submit }));

    const url = new URL(globalThis.location.href);
    expect(decodeURIComponent(url.searchParams.get('subject') ?? '')).toBe(
      'Bad CRM — nina@example.com',
    );
  });

  it('shows the confirmation status once the mail link is composed', async () => {
    render(
      <LocaleProvider>
        <FeedbackForm />
      </LocaleProvider>,
    );

    expect(screen.queryByText(EN_COPY.cta.form.sent)).not.toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(EN_COPY.cta.form.emailLabel), 'nina@example.com');
    await userEvent.type(screen.getByLabelText(EN_COPY.cta.form.messageLabel), 'Hello.');
    await userEvent.click(screen.getByRole('button', { name: EN_COPY.cta.form.submit }));

    expect(screen.getByRole('status')).toHaveTextContent(EN_COPY.cta.form.sent);
  });
});

/**
 * Name is optional, email and message are `required` — the browser's own constraint validation, per
 * the component's doc comment. Nothing here mocks `location`: if validation actually blocked the
 * submit handler, `location.href` (the real, unmocked one) is never touched, and asserting "no
 * confirmation appeared" is enough to prove the handler did not run.
 */
describe('the feedback form leans on native validation for required fields', () => {
  it('does not submit when the required email is empty', async () => {
    render(
      <LocaleProvider>
        <FeedbackForm />
      </LocaleProvider>,
    );

    await userEvent.type(screen.getByLabelText(EN_COPY.cta.form.messageLabel), 'Hello.');
    await userEvent.click(screen.getByRole('button', { name: EN_COPY.cta.form.submit }));

    expect(screen.queryByText(EN_COPY.cta.form.sent)).not.toBeInTheDocument();
  });

  it('does not submit when the required message is empty', async () => {
    render(
      <LocaleProvider>
        <FeedbackForm />
      </LocaleProvider>,
    );

    await userEvent.type(screen.getByLabelText(EN_COPY.cta.form.emailLabel), 'nina@example.com');
    await userEvent.click(screen.getByRole('button', { name: EN_COPY.cta.form.submit }));

    expect(screen.queryByText(EN_COPY.cta.form.sent)).not.toBeInTheDocument();
  });

  it('rejects an email that does not look like one, via type="email"', () => {
    render(
      <LocaleProvider>
        <FeedbackForm />
      </LocaleProvider>,
    );

    const email = screen.getByLabelText(EN_COPY.cta.form.emailLabel) as HTMLInputElement;
    expect(email.type).toBe('email');
  });

  it('does not require a name', async () => {
    render(
      <LocaleProvider>
        <FeedbackForm />
      </LocaleProvider>,
    );

    const name = screen.getByLabelText(EN_COPY.cta.form.nameLabel) as HTMLInputElement;
    expect(name.required).toBe(false);
  });
});
