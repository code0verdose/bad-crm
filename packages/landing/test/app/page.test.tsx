import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { App } from '@/app/app.component.js';
import { EN_COPY } from '@/app/i18n/dictionary-en.constant.js';
import { RU_COPY } from '@/app/i18n/dictionary-ru.constant.js';

/**
 * The copy carries non-breaking spaces — a line may not start with a preposition or an em dash.
 * Testing Library normalises whitespace in the *element* text before comparing, so the expected
 * string has to be normalised the same way or every typographic space becomes a failing test.
 */
const plain = (text: string): string => text.replaceAll('\u00a0', ' ');

describe('the page renders and switches language', () => {
  it('renders every section without throwing, with exactly one h1', () => {
    render(<App />);

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByText(plain(EN_COPY.replaces.footnote))).toBeInTheDocument();
    expect(screen.getByText(plain(EN_COPY.selfHost.priceNote))).toBeInTheDocument();
    expect(screen.getByText(plain(EN_COPY.graph.footnote))).toBeInTheDocument();
  });

  it('switches the whole page to Russian and records it on the document', async () => {
    render(<App />);

    await userEvent.click(screen.getByRole('button', { name: 'ru' }));

    expect(screen.getByText(plain(RU_COPY.replaces.footnote))).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('ru');
  });

  it('encrypts what is typed into the vault demo, in place', async () => {
    render(<App />);

    // By role and accessible name: that is the pairing a screen reader computes, and it fails if
    // the label ever stops being associated with the field.
    const field = screen.getByRole('textbox', { name: plain(EN_COPY.e2ee.inputLabel) });
    await userEvent.type(field, 'hunter2');

    expect(screen.queryByText(EN_COPY.e2ee.emptyState)).not.toBeInTheDocument();
    // The plaintext is in the field the reader owns and nowhere else on the page.
    expect(screen.queryAllByText(/hunter2/)).toHaveLength(0);
  });
});
