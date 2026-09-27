import { screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { axeViolationsIn } from '../support/axe-scan.util.js';
import {
  ALL,
  ME,
  PROJECT,
  card,
  cardReady,
  json,
  problem,
  sent,
  startAt,
  writes,
} from '../support/project-screen.util.js';

/**
 * `/projects/new` — the create half of STORY-014-01: the form, what it says about a refusal, and
 * where the reader stands afterwards.
 *
 * Mounted as the whole application on the stand the settings suite uses. Focus is the thread
 * through the cases below: a submit the form refuses and a submit the server refuses both leave
 * the caret on the first field that has to change, in the order the fields are on screen — not in
 * the order a schema or a server happened to list its issues.
 */

const platformFetch = globalThis.fetch;

afterEach(() => {
  vi.stubGlobal('fetch', platformFetch);
});

describe('creating a project', () => {
  const fill = async (user: UserEvent, key: string) => {
    // The session answers first: the reader becomes the default lead, and the form starts from that.
    await waitFor(() => {
      expect(screen.getByLabelText(/projects\.field\.lead/, { selector: 'select' })).toHaveValue(
        ME,
      );
    });
    await user.type(await screen.findByLabelText(/projects\.field\.key/), key);
    await user.type(screen.getByLabelText(/projects\.field\.name/), 'Bad CRM');
  };

  it('is refused without project:create, before anything renders', async () => {
    await startAt({ path: '/projects/new', granted: ['project:read'] });

    expect(await screen.findByText('project:create')).toBeInTheDocument();
    expect(screen.queryByLabelText(/projects\.field\.key/)).toBeNull();
  });

  it('refuses a malformed key under the key, and sends nothing', async () => {
    const user = userEvent.setup();

    await startAt({ path: '/projects/new' });

    await fill(user, '1x');
    await user.click(screen.getByRole('button', { name: 'projects.create.submit' }));

    expect(await screen.findByText('projects.field.keyInvalid')).toBeInTheDocument();
    expect(writes('POST')).toEqual([]);
  });

  it('puts a taken key under the key, with no toast', async () => {
    const user = userEvent.setup();

    await startAt({ path: '/projects/new', write: () => problem(409, 'project_already_exists') });

    await fill(user, 'bad');
    await user.click(screen.getByRole('button', { name: 'projects.create.submit' }));

    expect(await screen.findByText('projects.field.keyTaken')).toBeInTheDocument();
    expect(screen.getByLabelText(/projects\.field\.key/)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByText('errors.code.project_already_exists')).toBeNull();
  });

  it('creates it led by the reader, lands on its card without reading it again, and says so', async () => {
    const user = userEvent.setup();
    const created = () => json(card(ALL, { id: PROJECT, key: 'BAD' }), 201);

    const { router } = await startAt({ path: '/projects/new', write: created });

    await fill(user, ' bad ');
    await user.click(screen.getByRole('button', { name: 'projects.create.submit' }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/projects/${PROJECT}`);
    });
    expect(writes('POST')[0]?.body).toEqual({
      key: 'bad',
      name: 'Bad CRM',
      description: null,
      visibility: 'PUBLIC_ORG',
      leadId: ME,
      color: 'brand',
      startedAt: null,
      dueAt: null,
    });
    await cardReady();
    expect(await screen.findByText('projects.created')).toBeInTheDocument();
    expect(
      sent.filter((call) => call.method === 'GET' && call.url === `/api/v1/projects/${PROJECT}`),
    ).toEqual([]);
  });
});

describe('creating a project — what the form says above its fields', () => {
  const submitNew = async (user: UserEvent) => {
    await waitFor(() => {
      expect(screen.getByLabelText(/projects\.field\.lead/, { selector: 'select' })).toHaveValue(
        ME,
      );
    });
    await user.type(await screen.findByLabelText(/projects\.field\.key/), 'BAD');
    await user.type(screen.getByLabelText(/projects\.field\.name/), 'Bad CRM');
    await user.click(screen.getByRole('button', { name: 'projects.create.submit' }));
  };

  it('shows a failure about the request as one alert above the form', async () => {
    const user = userEvent.setup();

    await startAt({ path: '/projects/new', write: () => problem(500, 'internal_error') });

    await submitNew(user);

    expect(await screen.findAllByText('errors.code.internal_error')).toHaveLength(1);
    expect(screen.getByRole('alert')).toHaveTextContent('errors.code.internal_error');
  });

  it('keeps the seconds of a rate limit in that alert', async () => {
    const user = userEvent.setup();
    const limited = () =>
      new Response(
        JSON.stringify({
          type: 'about:blank',
          title: 'x',
          status: 429,
          code: 'rate_limited',
          requestId: 'r',
        }),
        {
          status: 429,
          headers: { 'content-type': 'application/problem+json', 'retry-after': '30' },
        },
      );

    await startAt({ path: '/projects/new', write: limited });

    await submitNew(user);

    expect(await screen.findByText('errors.code.rate_limited')).toBeInTheDocument();
  });

  it('offers the reader alone as the lead when they may not see the directory', async () => {
    await startAt({ path: '/projects/new', granted: ['project:read', 'project:create'] });

    // Re-read inside the wait: the form is keyed by the reader and remounts once the session answers.
    const lead = () => screen.getByLabelText(/projects\.field\.lead/, { selector: 'select' });

    await waitFor(() => {
      expect(lead()).toHaveValue(ME);
    });
    expect(
      within(lead())
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['projects.field.leadChoose', 'projects.field.leadYou']);
  });
});

describe('creating a project — to a screen reader and a keyboard', () => {
  /** The session has answered and the form is the one keyed by the reader. */
  const formReady = async () => {
    await waitFor(() => {
      expect(screen.getByLabelText(/projects\.field\.lead/, { selector: 'select' })).toHaveValue(
        ME,
      );
    });
  };

  const submit = async (user: UserEvent) => {
    const button = screen.getByRole('button', { name: 'projects.create.submit' });

    button.focus();
    await user.keyboard('{Enter}');
  };

  it('has no axe violations', async () => {
    const { container } = await startAt({ path: '/projects/new' });

    await formReady();

    expect(await axeViolationsIn(container, { control: 'aria-allowed-attr' })).toEqual([]);
  });

  it('puts the focus on the first field the form refused, in screen order', async () => {
    const user = userEvent.setup();

    await startAt({ path: '/projects/new' });
    await formReady();
    // The key is fine, the name is missing and the dates are crossed: the name comes first.
    await user.type(screen.getByLabelText(/projects\.field\.key/), 'BAD');
    await user.type(screen.getByLabelText('projects.field.startedAt'), '2026-12-01');
    await user.type(screen.getByLabelText('projects.field.dueAt'), '2026-09-01');
    await submit(user);

    await waitFor(() => {
      expect(screen.getByLabelText(/projects\.field\.name/)).toHaveFocus();
    });
    expect(writes('POST')).toEqual([]);
  });

  it('puts the focus on the field the server refused', async () => {
    const user = userEvent.setup();

    await startAt({ path: '/projects/new', write: () => problem(409, 'project_already_exists') });
    await formReady();
    await user.type(screen.getByLabelText(/projects\.field\.key/), 'BAD');
    await user.type(screen.getByLabelText(/projects\.field\.name/), 'Bad CRM');
    await submit(user);

    const key = screen.getByLabelText(/projects\.field\.key/);

    await waitFor(() => {
      expect(key).toHaveAttribute('aria-invalid', 'true');
    });
    await waitFor(() => {
      expect(key).toHaveFocus();
    });
  });

  it('takes the first of the server’s fields in screen order, not in the order it listed them', async () => {
    const user = userEvent.setup();

    await startAt({
      path: '/projects/new',
      write: () =>
        problem(422, 'validation_failed', {
          errors: [
            { path: 'leadId', code: 'invalid_value', message: 'x' },
            { path: 'name', code: 'too_big', message: 'x' },
          ],
        }),
    });
    await formReady();
    await user.type(screen.getByLabelText(/projects\.field\.key/), 'BAD');
    await user.type(screen.getByLabelText(/projects\.field\.name/), 'Bad CRM');
    await submit(user);

    const name = screen.getByLabelText(/projects\.field\.name/);

    await waitFor(() => {
      expect(name).toHaveAttribute('aria-invalid', 'true');
    });
    await waitFor(() => {
      expect(name).toHaveFocus();
    });
  });

  it('does not move the focus again while the reader corrects another field', async () => {
    const user = userEvent.setup();

    await startAt({ path: '/projects/new', write: () => problem(409, 'project_already_exists') });
    await formReady();
    await user.type(screen.getByLabelText(/projects\.field\.key/), 'BAD');
    await user.type(screen.getByLabelText(/projects\.field\.name/), 'Bad CRM');
    await submit(user);

    const key = screen.getByLabelText(/projects\.field\.key/);

    await waitFor(() => {
      expect(key).toHaveFocus();
    });

    const description = screen.getByLabelText('projects.field.description');

    await user.click(description);
    await user.type(description, 'Six tools in one.');

    expect(description).toHaveFocus();
  });

  it('lands on the new card with the focus on its heading', async () => {
    const user = userEvent.setup();
    const created = () => json(card(ALL, { id: PROJECT, key: 'BAD' }), 201);

    const { router } = await startAt({ path: '/projects/new', write: created });

    await formReady();
    await user.type(screen.getByLabelText(/projects\.field\.key/), 'BAD');
    await user.type(screen.getByLabelText(/projects\.field\.name/), 'Bad CRM');
    await submit(user);

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/projects/${PROJECT}`);
    });
    await cardReady();
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 })).toHaveFocus();
    });
    // The created project's page, named by its key and name (STORY-014-06, acceptance 8).
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('BAD · Bad CRM');
    expect(sent.some((call) => call.method === 'POST')).toBe(true);
  });
});
