import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SESSION_STATUSES, SESSION_STATUS_LABEL_KEY } from '@units/auth/model';
import { SessionStatusBadge } from '@units/auth/ui';

describe('SessionStatusBadge', () => {
  it.each([...SESSION_STATUSES])('renders the translation key of %s', (status) => {
    render(<SessionStatusBadge status={status} />);

    expect(screen.getByText(SESSION_STATUS_LABEL_KEY[status])).toHaveAttribute(
      'data-session-status',
      status,
    );
  });

  /**
   * The attribute is the contract with tests and stylesheets; the text is not. Pinning it here is
   * what allows the label to become a translated string without every other test being rewritten.
   */
  it('exposes the status as an attribute, not only as text', () => {
    const { container } = render(<SessionStatusBadge status="authenticated" />);

    expect(container.querySelector('[data-session-status="authenticated"]')).not.toBeNull();
  });
});
