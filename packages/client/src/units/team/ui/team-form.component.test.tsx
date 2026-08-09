import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { MAX_DESCRIPTION, MAX_NAME, MAX_SLUG } from '@units/team/model';
import { TeamForm } from '@units/team/ui';

/**
 * The three fields' `maxLength`, asserted against the same constants the schema enforces rather
 * than against a number copied into this file.
 *
 * `docs/api/openapi.yaml` publishes one bound per field, and until now it was spelled three times in
 * the source — once in `teamFormSchema`, twice more as literal `maxLength` props here — with nothing
 * asserting the three agreed. `MAX_NAME`/`MAX_SLUG`/`MAX_DESCRIPTION` are now exported from the
 * schema and imported here, so a widened `maxLength` (typed past the contract, refused by a 422 the
 * form never explained) and a narrowed one (refusing input the contract would accept) are both a
 * failure of *this* assertion — importing the schema's own numbers rather than restating `120` is
 * what makes the two impossible to drift apart, not merely checked.
 */
const renderForm = () => {
  const onSubmit = vi.fn();

  render(
    <MantineProvider env="test">
      <TeamForm
        initialValues={{ name: '', slug: '', description: '' }}
        isPending={false}
        onSubmit={onSubmit}
        submitLabelKey="teams.create.submit"
      />
    </MantineProvider>,
  );

  return { onSubmit, user: userEvent.setup() };
};

describe('the field limits', () => {
  it('caps the name input at the schema bound', () => {
    renderForm();

    expect(screen.getByLabelText(/teams\.field\.name/)).toHaveAttribute(
      'maxLength',
      String(MAX_NAME),
    );
  });

  it('caps the slug input at the schema bound', () => {
    renderForm();

    expect(screen.getByLabelText(/teams\.field\.slug/)).toHaveAttribute(
      'maxLength',
      String(MAX_SLUG),
    );
  });

  it('caps the description textarea at the schema bound', () => {
    renderForm();

    expect(screen.getByLabelText(/teams\.field\.description/)).toHaveAttribute(
      'maxLength',
      String(MAX_DESCRIPTION),
    );
  });
});

describe('required fields', () => {
  it('refuses an empty slug at the field, the same way it refuses an empty name', async () => {
    const { onSubmit, user } = renderForm();

    await user.type(screen.getByLabelText(/teams\.field\.name/), 'Backend');
    await user.click(screen.getByRole('button', { name: /teams\.create\.submit/ }));

    expect(await screen.findByText(/validation\.required/)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
