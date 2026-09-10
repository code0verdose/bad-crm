import { MantineProvider } from '@mantine/core';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it, vi } from 'vitest';

import { RegisterForm } from '@units/auth/ui';

/**
 * The form that creates an installation's first organization — five fields, and the two rules that
 * make it different from every other form in the product.
 *
 * **It is the only form nobody can be signed in to fix.** Whoever fills it in has no account yet, so
 * a mistake it lets through comes back as a `422` about a request rather than as a message about a
 * field. That is why the slug pattern and the password policy are checked here, before anything is
 * sent (`docs/api/openapi.yaml` → `registerOrganization`, `RegisterOrganizationRequest`).
 *
 * **The server's own verdicts arrive as props.** A slug that is already taken is a statement about
 * the slug field and is rendered under it (`rules/errors-and-toasts.mdc` §4); anything else the
 * server refuses for is a statement about the request and is rendered above the fields. Neither is
 * a toast — see `register-organization.mutation.ts` for the half that stops one being raised.
 */
const renderForm = (props: Partial<Parameters<typeof RegisterForm>[0]> = {}) => {
  const onSubmit = vi.fn();

  const { container } = render(
    <MantineProvider env="test">
      <RegisterForm isPending={false} onSubmit={onSubmit} {...props} />
    </MantineProvider>,
  );

  return { container, onSubmit, user: userEvent.setup() };
};

interface Filling {
  readonly organizationName?: string;
  readonly slug?: string;
  readonly email?: string;
  readonly password?: string;
  readonly confirmPassword?: string;
}

const VALID: Required<Filling> = {
  organizationName: 'Bad Company',
  slug: 'bad-company',
  email: 'ada@example.com',
  password: 'correct-horse-battery',
  confirmPassword: 'correct-horse-battery',
};

const fill = async (user: ReturnType<typeof userEvent.setup>, filling: Filling = {}) => {
  const values = { ...VALID, ...filling };

  await user.type(
    screen.getByLabelText(/auth\.register\.organizationName\.label/),
    values.organizationName,
  );
  await user.type(screen.getByLabelText(/auth\.register\.slug\.label/), values.slug);
  await user.type(screen.getByLabelText(/auth\.register\.email\.label/), values.email);
  await user.type(screen.getByLabelText(/auth\.register\.password\.label/), values.password);
  await user.type(
    screen.getByLabelText(/auth\.register\.confirmPassword\.label/),
    values.confirmPassword,
  );
  await user.click(screen.getByRole('button', { name: 'auth.register.submit' }));
};

describe('the registration form', () => {
  it('hands over an organization and its owner', async () => {
    const { onSubmit, user } = renderForm();

    await fill(user);

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(VALID);
  });

  it.each([
    ['a slug that is not one', { slug: 'Bad Company' }, 'auth.register.field.slugInvalid'],
    ['an address that is not one', { email: 'ada' }, 'validation.email.invalid'],
    [
      'a password under the policy',
      { password: 'short', confirmPassword: 'short' },
      'validation.password.too_short',
    ],
    [
      'two passwords that differ',
      { confirmPassword: 'something-else-12' },
      'validation.password.mismatch',
    ],
    // The server's half of the policy, applied here from the same shared check: until 2026-09-06
    // this password crossed the wire, came back as a `422`, and the form said «check the
    // highlighted fields» with nothing highlighted.
    [
      'a password the policy calls weak',
      { password: 'qwertyuiop12', confirmPassword: 'qwertyuiop12' },
      'validation.password.weak',
    ],
    ['an empty organization name', { organizationName: ' ' }, 'validation.required'],
  ])('refuses %s without asking the server', async (_case, filling, message) => {
    const { onSubmit, user } = renderForm();

    await fill(user, filling as Filling);

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('ties the first message to its field and puts the focus there', async () => {
    const { user } = renderForm();

    await fill(user, { organizationName: ' ' });

    const name = screen.getByLabelText(/auth\.register\.organizationName\.label/);
    const message = await screen.findByText('validation.required');
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(name.getAttribute('aria-describedby')).toContain(message.id);
    await waitFor(() => {
      expect(document.activeElement).toBe(name);
    });
  });

  it('renders the taken slug under the slug field, not over the form', async () => {
    renderForm({ slugError: { key: 'errors.code.organization_already_exists' } });

    const slug = screen.getByLabelText(/auth\.register\.slug\.label/);
    const message = await screen.findByText('errors.code.organization_already_exists');
    expect(slug).toHaveAttribute('aria-invalid', 'true');
    expect(slug.getAttribute('aria-describedby')).toContain(message.id);
  });

  it('announces a refusal that belongs to no field', () => {
    renderForm({ notice: { key: 'errors.code.rate_limited' } });

    expect(screen.getByRole('alert')).toHaveTextContent('errors.code.rate_limited');
  });

  it("renders the server's verdict on the password under the password field", async () => {
    renderForm({ passwordError: { key: 'validation.password.weak' } });

    const password = screen.getByLabelText(/auth\.register\.password\.label/);
    const message = await screen.findByText('validation.password.weak');
    expect(password).toHaveAttribute('aria-invalid', 'true');
    expect(password.getAttribute('aria-describedby')).toContain(message.id);
  });

  it('carries the wait on the submit button', () => {
    renderForm({ isPending: true });

    expect(screen.getByRole('button', { name: 'auth.register.submit' })).toHaveAttribute(
      'data-loading',
      'true',
    );
  });

  it('has no accessibility violation, filled in or in error', async () => {
    const { container, user } = renderForm({ notice: { key: 'errors.code.rate_limited' } });
    await fill(user, { email: 'ada' });
    await screen.findByText('validation.email.invalid');

    const { violations } = await axe.run(container, {
      // Colours live in a stylesheet jsdom never loads; contrast is measured from the tokens in
      // `test/theme/tokens.test.ts`, where the real values are.
      rules: { 'color-contrast': { enabled: false } },
    });

    expect(violations.map((violation) => violation.id)).toEqual([]);
  });
});
