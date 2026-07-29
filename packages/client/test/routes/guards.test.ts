import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { isRedirect } from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';

import { AuthLib, AuthModel } from '@units/auth';

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

const argsFor = (
  status: AuthModel.SessionStatus,
  search?: { redirect?: string | undefined },
): AuthLib.GuardArgs => ({
  context: { auth: { status } },
  location: LOCATION,
  ...(search === undefined ? {} : { search }),
});

const thrownBy = (guard: () => void): unknown => {
  try {
    guard();
  } catch (error) {
    return error;
  }

  return undefined;
};

describe('requireSession', () => {
  it('lets an authenticated user through', () => {
    expect(() => {
      AuthLib.requireSession(argsFor('authenticated'));
    }).not.toThrow();
  });

  it('sends an anonymous user to the login screen, keeping where they were going', () => {
    const thrown = thrownBy(() => {
      AuthLib.requireSession(argsFor('anonymous'));
    });

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
  it.each([['anonymous'], ['unknown']] as const)(
    'keeps a %s visitor on the public page',
    (status) => {
      expect(() => {
        AuthLib.redirectIfAuthed(argsFor(status));
      }).not.toThrow();
    },
  );

  it('sends an authenticated user to the dashboard when the URL asked for nothing', () => {
    const thrown = thrownBy(() => {
      AuthLib.redirectIfAuthed(argsFor('authenticated'));
    });

    expect(isRedirect(thrown)).toBe(true);
    expect(thrown).toMatchObject({ options: { href: AuthModel.POST_LOGIN_PATH } });
  });

  /**
   * The return leg of a sign-in. `requireSession` put the destination in `search.redirect`; this is
   * where it is spent, which is why the sign-in form itself navigates nowhere.
   */
  it('returns an authenticated user to the page they were originally going to', () => {
    const thrown = thrownBy(() => {
      AuthLib.redirectIfAuthed(argsFor('authenticated', { redirect: '/settings/security' }));
    });

    expect(thrown).toMatchObject({ options: { href: '/settings/security' } });
  });
});

/**
 * The destination is attacker-controlled by construction: the link is built by whoever sends it,
 * the domain is this installation and the login form is the real one. `loginSearchSchema` is the
 * mitigation, and what is asserted here is that the guard spends what the schema produced — a guard
 * reading the raw parameter would be an open redirect with a validated value sitting unused beside
 * it.
 */
describe('what the guard is allowed to return to', () => {
  it.each([
    ['an absolute URL', 'https://evil.example/x'],
    ['a protocol-relative URL', '//evil.example/x'],
    ['a backslash after the slash, which a browser reads as protocol-relative', '/\\evil.example'],
    ['a scheme', 'javascript:alert(1)'],
    ['a bare path with no leading slash', 'evil.example'],
    /**
     * The forms that survive an unanchored pattern. `.` matches everything except a line
     * terminator, so a pattern with no `$` stops matching at the first one and reports a match
     * anyway: `/\n//evil.example` is «a slash, then something the pattern never looked at».
     *
     * Nothing is exploitable through the router today — handed a value it cannot read as absolute,
     * it keeps the `pathname` and the host is dropped. That is exactly the objection: the property
     * this schema exists to guarantee would be held up by the internals of a dependency, and the
     * day those change the hole opens with no edit of ours.
     */
    ['a newline the pattern stopped at', '/\n//evil.example'],
    ['a carriage return', '/\r//evil.example'],
    ['a line separator', '/\u2028//evil.example'],
    ['a NUL byte', '/\u0000//evil.example'],
    ['a tab', '/\t//evil.example'],
  ])('falls back to the dashboard when the URL carried %s', (_case, redirect) => {
    const search = AuthModel.loginSearchSchema.parse({ redirect });

    const thrown = thrownBy(() => {
      AuthLib.redirectIfAuthed(argsFor('authenticated', search));
    });

    expect(search.redirect).toBeUndefined();
    expect(thrown).toMatchObject({ options: { href: AuthModel.POST_LOGIN_PATH } });
  });

  it('keeps a path on this origin, query string and all', () => {
    const search = AuthModel.loginSearchSchema.parse({ redirect: '/dashboard?range=30d' });

    const thrown = thrownBy(() => {
      AuthLib.redirectIfAuthed(argsFor('authenticated', search));
    });

    expect(thrown).toMatchObject({ options: { href: '/dashboard?range=30d' } });
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

  /**
   * `units/session` was the reference unit of the tree and is gone: EPIC-006 merged it into
   * `units/auth`, exactly as `docs/product/glossary.md` said it would. Asserted against the tree
   * because a leftover directory keeps resolving, keeps passing every architecture sweep, and
   * leaves two homes for one concept.
   */
  it('leaves nothing behind in units/session either', () => {
    expect(existsSync(`${CLIENT_SRC}/units/session`)).toBe(false);
  });
});
