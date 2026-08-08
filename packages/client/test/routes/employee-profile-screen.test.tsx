import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `/admin/members/$userId` — the personnel record.
 *
 * The property that only shows up here is that **the screen is built from what arrived**, not from
 * what the client believes it may see: the server sends a document with no employment keys at all to
 * a caller without `employee:view_personal_data`, and the form has to render that without inventing
 * values or crashing.
 */

const USER = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5af1';

let sent: { url: string; method: string; body: unknown }[];

const platformFetch = globalThis.fetch;

const json = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** What a colleague receives: the public half, and not one employment key. */
const publicProfile = {
  userId: USER,
  email: 'ivan@example.test',
  firstName: 'Ivan',
  lastName: 'Petrov',
  jobTitle: 'Backend engineer',
  department: 'Platform',
  managerId: null,
  timezone: 'Europe/Moscow',
  skills: ['ts'],
};

/** Somebody nobody has filled in yet: every optional field cleared, the timezone at its default. */
const emptyProfile = {
  userId: USER,
  email: 'ivan@example.test',
  firstName: '',
  lastName: '',
  jobTitle: null,
  department: null,
  managerId: null,
  timezone: '',
  skills: [],
  employmentType: 'FULL_TIME',
  hiredAt: null,
  terminatedAt: null,
  weeklyCapacityHours: 40,
  emergencyContact: null,
};

const personalProfile = {
  ...publicProfile,
  employmentType: 'PART_TIME',
  hiredAt: '2024-03-01',
  terminatedAt: null,
  weeklyCapacityHours: 20,
  emergencyContact: 'sister, +7 900 000-00-00',
};

const stubServer = (options: {
  readonly personal?: boolean;
  readonly empty?: boolean;
  readonly granted?: string[];
}): void => {
  vi.stubGlobal('fetch', async (input: Request) => {
    const url = new URL(input.url).pathname;
    const body = input.method === 'PATCH' ? await input.clone().json() : undefined;

    sent.push({ url, method: input.method, body });

    if (url.endsWith('/me/permissions')) {
      return json({
        permissions: options.granted ?? [],
        denied: [],
        roles: [],
        isOwner: false,
        version: 1,
      });
    }
    if (url.endsWith(`/employees/${USER}`)) {
      if (options.empty === true) return json(emptyProfile);

      return json(options.personal === true ? personalProfile : publicProfile);
    }

    return json({ status: 'ok' });
  });
};

const startAt = async (options: {
  readonly personal?: boolean;
  readonly empty?: boolean;
  readonly granted?: string[];
}): Promise<void> => {
  vi.resetModules();
  stubServer(options);

  const { renderApp } = await import('../support/render-app.util.js');

  renderApp({ path: `/admin/members/${USER}`, status: 'authenticated' });
};

beforeEach(() => {
  sent = [];
});

afterEach(() => {
  vi.stubGlobal('fetch', platformFetch);
});

describe('/admin/members/$userId', () => {
  it('shows what arrived and lets the person edit their own name', async () => {
    const user = userEvent.setup();

    await startAt({ personal: true, granted: [] });

    const firstName = await screen.findByLabelText(/employee\.firstName/);

    expect(firstName).toHaveValue('Ivan');

    await user.clear(firstName);
    await user.type(firstName, 'Ivan-Sergey');
    await user.click(screen.getByRole('button', { name: /employee\.save/ }));

    await waitFor(() => {
      expect(sent.some((call) => call.method === 'PATCH')).toBe(true);
    });

    const saved = sent.find((call) => call.method === 'PATCH');

    expect(saved?.body).toMatchObject({ firstName: 'Ivan-Sergey', lastName: 'Petrov' });
  });

  it('disables the employment fields for somebody who may not edit them', async () => {
    // Disabled rather than hidden: the contract type is a fact about the person that they may read,
    // and hiding a value somebody may see turns a permission boundary into a guessing game.
    await startAt({ personal: true, granted: [] });

    expect(await screen.findByLabelText(/employee\.jobTitle/)).toBeDisabled();
    expect(screen.getByLabelText(/employee\.capacity$/)).toBeDisabled();
    // The self-service half stays editable.
    expect(screen.getByLabelText(/employee\.firstName/)).toBeEnabled();
  });

  it('enables them for somebody who holds employee:update', async () => {
    await startAt({ personal: true, granted: ['employee:update'] });

    expect(await screen.findByLabelText(/employee\.jobTitle/)).toBeEnabled();
  });

  it('will not let an edit erase an emergency contact the server withheld', async () => {
    // A caller with `employee:update` and without `employee:view_personal_data`: the document has no
    // `emergencyContact` key, so the field shows empty. Enabled, it would be one save away from
    // overwriting the stored ciphertext with nothing.
    await startAt({ personal: false, granted: ['employee:read', 'employee:update'] });

    expect(await screen.findByLabelText(/employee\.emergencyContact/)).toBeDisabled();
  });

  it('lets a person fill in their own emergency contact without any capability', async () => {
    // CONTROL for the case above: the field is self-service, not employment. Disabling it for
    // everybody would be the other way to get this wrong.
    await startAt({ personal: true, granted: [] });

    expect(await screen.findByLabelText(/employee\.emergencyContact/)).toBeEnabled();
  });

  it('renders a document that carries no employment keys at all', async () => {
    // What a colleague receives. The form must not invent values or fail on the missing keys.
    await startAt({ personal: false, granted: ['employee:read'] });

    expect(await screen.findByLabelText(/employee\.firstName/)).toHaveValue('Ivan');
    // The fallback is «this caller was not shown it», and the field it backs is disabled anyway.
    expect(screen.getByLabelText(/employee\.capacity$/)).toHaveValue('40');
  });

  it('renders a record nobody has filled in yet, without inventing anything', async () => {
    // Somebody who accepted an invitation this morning. Every cleared field comes back as `null`,
    // and the timezone falls back to the browser's rather than to a guess about where they are.
    await startAt({ empty: true, granted: ['employee:update'] });

    expect(await screen.findByLabelText(/employee\.firstName/)).toHaveValue('');
    expect(screen.getByLabelText(/employee\.jobTitle/)).toHaveValue('');
    expect(screen.getByLabelText(/employee\.skills/)).toHaveValue('');
    expect(screen.getByLabelText(/employee\.timezone/)).not.toHaveValue('');
  });

  it('offers a way back when the record cannot be loaded', async () => {
    // `DataState` owns the four states; what this asserts is that the retry actually re-asks rather
    // than being a button that does nothing.
    const user = userEvent.setup();

    vi.resetModules();
    vi.stubGlobal('fetch', (input: Request) => {
      const url = new URL(input.url).pathname;

      sent.push({ url, method: input.method, body: undefined });

      if (url.endsWith('/me/permissions')) {
        return Promise.resolve(
          json({ permissions: [], denied: [], roles: [], isOwner: false, version: 1 }),
        );
      }

      return Promise.resolve(json({ code: 'internal_error', status: 500 }, 500));
    });

    const { renderApp } = await import('../support/render-app.util.js');

    renderApp({ path: `/admin/members/${USER}`, status: 'authenticated' });

    const retry = await screen.findByRole('button', { name: /retry/i });
    const before = sent.filter((call) => call.url.endsWith(`/employees/${USER}`)).length;

    await user.click(retry);

    await waitFor(() => {
      expect(sent.filter((call) => call.url.endsWith(`/employees/${USER}`)).length).toBeGreaterThan(
        before,
      );
    });
  });

  it('clears a field rather than sending an empty string', async () => {
    // An empty job title and a removed one render identically and are different values in a column.
    const user = userEvent.setup();

    await startAt({ personal: true, granted: ['employee:update'] });

    await user.clear(await screen.findByLabelText(/employee\.jobTitle/));
    await user.click(screen.getByRole('button', { name: /employee\.save/ }));

    await waitFor(() => {
      expect(sent.some((call) => call.method === 'PATCH')).toBe(true);
    });
    expect(sent.find((call) => call.method === 'PATCH')?.body).toMatchObject({ jobTitle: null });
  });
});
