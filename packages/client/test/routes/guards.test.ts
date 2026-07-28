import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { isRedirect } from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';

import { AuthLib, AuthModel } from '@units/auth';
import { SessionModel } from '@units/session';

/**
 * The guards, as pure functions — allowed, denied, and the state in between.
 *
 * `rules/testing.mdc` §8 asks a route guard for «allowed + denied → redirect»; the third case is the
 * one that is easy to get wrong and impossible to see: while the session bootstrap is still in
 * flight the client genuinely does not know who the user is, and a guard that treats «do not know»
 * as «anonymous» throws a signed-in user onto the login screen on every reload.
 */

/**
 * Resolved from the working directory rather than from `import.meta.url`: this suite runs in the
 * jsdom environment, where the module URL is an `http:` one and `fileURLToPath` refuses it. Vitest
 * runs with the package root as cwd, which `vitest.config.ts` also relies on for `include`.
 */
const CLIENT_SRC = resolve(process.cwd(), 'src');

const LOCATION = { href: '/dashboard?range=7d' };

const argsFor = (status: AuthModel.GuardSessionStatus): AuthLib.GuardArgs => ({
  context: { auth: { status } },
  location: LOCATION,
});

describe('requireSession', () => {
  it('lets an authenticated user through', () => {
    expect(() => {
      AuthLib.requireSession(argsFor('authenticated'));
    }).not.toThrow();
  });

  it('sends an anonymous user to the login screen, keeping where they were going', () => {
    let thrown: unknown;

    try {
      AuthLib.requireSession(argsFor('anonymous'));
    } catch (error) {
      thrown = error;
    }

    expect(isRedirect(thrown)).toBe(true);
    expect(thrown).toMatchObject({
      options: { to: '/login', search: { redirect: '/dashboard?range=7d' } },
    });
  });

  it('waits rather than redirecting while the session is still unknown', () => {
    expect(() => {
      AuthLib.requireSession(argsFor('unknown'));
    }).not.toThrow();
  });
});

describe('redirectIfAuthed', () => {
  it('keeps an anonymous user on the public page', () => {
    expect(() => {
      AuthLib.redirectIfAuthed(argsFor('anonymous'));
    }).not.toThrow();
  });

  it('keeps a user of unknown session on the public page', () => {
    expect(() => {
      AuthLib.redirectIfAuthed(argsFor('unknown'));
    }).not.toThrow();
  });

  it('sends an authenticated user to the dashboard instead of showing a login form', () => {
    let thrown: unknown;

    try {
      AuthLib.redirectIfAuthed(argsFor('authenticated'));
    } catch (error) {
      thrown = error;
    }

    expect(isRedirect(thrown)).toBe(true);
    expect(thrown).toMatchObject({ options: { to: '/dashboard' } });
  });
});

/**
 * The guards live in `units/auth/lib/guards` (STORY-004-05), and a unit may not import the layer
 * above it or another unit — so the status vocabulary they branch on is declared inside the auth
 * unit rather than taken from `units/session`.
 *
 * That leaves two vocabularies which have to stay one, and each half is kept by a different
 * mechanism. `tsc` covers widening: the route files hand these guards the router context, whose
 * `auth.status` comes from `units/session`, and a parameter type is checked contravariantly — a
 * status added there and not here fails to compile in the route file, which is exactly where
 * somebody has to decide what the guard should do about it. This covers the other half, the one a
 * type cannot see: renamed or removed on both sides in different ways, both sides still compile and
 * the guard quietly decides on a value nobody produces.
 */
describe('the vocabulary the guards decide on', () => {
  it('is the list the session unit publishes, in the same order', () => {
    expect([...AuthModel.GUARD_SESSION_STATUSES]).toEqual([...SessionModel.SESSION_STATUSES]);
  });
});

/**
 * A move is only done when the old address has stopped working. Asserted against the tree rather
 * than against the imports above: an `app/guards` left in place would keep resolving, and this
 * suite would keep passing over a story that was never finished.
 */
describe('where the guards live', () => {
  it('reaches them through the auth unit barrel', () => {
    expect(typeof AuthLib.requireSession).toBe('function');
    expect(typeof AuthLib.redirectIfAuthed).toBe('function');
  });

  it('holds them in units/auth/lib/guards', () => {
    expect(existsSync(`${CLIENT_SRC}/units/auth/lib/guards/require-session.guard.ts`)).toBe(true);
    expect(existsSync(`${CLIENT_SRC}/units/auth/lib/guards/redirect-if-authed.guard.ts`)).toBe(
      true,
    );
  });

  it('leaves nothing behind in app/guards', () => {
    expect(existsSync(`${CLIENT_SRC}/app/guards`)).toBe(false);
  });
});
