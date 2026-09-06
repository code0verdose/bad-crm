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

/**
 * The same arguments, for a session the organization's policy has scoped to enrolment.
 *
 * `mfaEnrollment` is **absent** rather than `false` on an ordinary session — the server states
 * presence and the schema keeps it that way — so the two helpers differ by whether the field is
 * there at all, which is the distinction both guards below actually branch on.
 */
const scopedArgs = (status: AuthModel.SessionStatus): AuthLib.GuardArgs => ({
  context: { auth: { status, mfaEnrollment: true } },
  location: LOCATION,
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
    expect(typeof AuthLib.requireFullSession).toBe('function');
    expect(typeof AuthLib.requireEnrolment).toBe('function');
  });

  it('holds them in units/auth/lib/guards', () => {
    expect(existsSync(`${CLIENT_SRC}/units/auth/lib/guards/require-session.guard.ts`)).toBe(true);
    expect(existsSync(`${CLIENT_SRC}/units/auth/lib/guards/redirect-if-authed.guard.ts`)).toBe(
      true,
    );
    expect(existsSync(`${CLIENT_SRC}/units/auth/lib/guards/require-full-session.guard.ts`)).toBe(
      true,
    );
    expect(existsSync(`${CLIENT_SRC}/units/auth/lib/guards/require-enrolment.guard.ts`)).toBe(true);
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

/**
 * The gate on the protected half, for a session the organization's second-factor policy has scoped
 * to enrolment (STORY-013-05, acceptance 3; STORY-013-04, acceptance 8).
 *
 * It is the same guard `_authenticated` already carried, with one more question after the session
 * one — and mounting it there rather than listing routes is the point: the server refuses every
 * route outside a three-entry whitelist with 403 `mfa_enrollment_required`, so a screen this guard
 * forgot would not be a screen with a missing check, it would be a screen where every control
 * answers 403 with no explanation of what is wanted.
 */
describe('requireFullSession', () => {
  it('lets an ordinary session through', () => {
    expect(() => {
      AuthLib.requireFullSession(argsFor('authenticated'));
    }).not.toThrow();
  });

  it('still sends an anonymous visitor to the login screen, keeping where they were going', () => {
    const thrown = thrownBy(() => {
      AuthLib.requireFullSession(argsFor('anonymous'));
    });

    expect(isRedirect(thrown)).toBe(true);
    expect(thrown).toMatchObject({
      options: { to: '/login', search: { redirect: '/dashboard?range=7d' } },
    });
  });

  it('sends a session scoped to enrolment to the wizard', () => {
    const thrown = thrownBy(() => {
      AuthLib.requireFullSession(scopedArgs('authenticated'));
    });

    expect(isRedirect(thrown)).toBe(true);
    expect(thrown).toMatchObject({ options: { to: AuthModel.MFA_ENROLMENT_PATH } });
  });

  /**
   * The session check comes first, and the order is not cosmetic: a scoped session that has since
   * been signed out has to meet `/login` with its destination remembered, not a wizard it can no
   * longer talk to.
   */
  it('answers the session question before the scope one', () => {
    const thrown = thrownBy(() => {
      AuthLib.requireFullSession({
        context: { auth: { status: 'anonymous', mfaEnrollment: true } },
        location: LOCATION,
      });
    });

    expect(thrown).toMatchObject({ options: { to: '/login' } });
  });

  it('waits rather than redirecting while the session is still unknown', () => {
    expect(() => {
      AuthLib.requireFullSession(argsFor('unknown'));
    }).not.toThrow();
  });
});

/**
 * The mirror, on the wizard itself — and the half that makes the enrolment screen a room rather
 * than a trap.
 *
 * It is what carries somebody **out** once the enrolment is done: confirming rotates the session,
 * the new access token is no longer scoped, the router re-checks its guards, and this one finds a
 * session that has no business here any more.
 */
describe('requireEnrolment', () => {
  it('keeps a scoped session on the wizard', () => {
    expect(() => {
      AuthLib.requireEnrolment(scopedArgs('authenticated'));
    }).not.toThrow();
  });

  it('sends an ordinary session into the application', () => {
    const thrown = thrownBy(() => {
      AuthLib.requireEnrolment(argsFor('authenticated'));
    });

    expect(isRedirect(thrown)).toBe(true);
    expect(thrown).toMatchObject({ options: { href: AuthModel.POST_LOGIN_PATH } });
  });

  it('sends an anonymous visitor to the login screen', () => {
    const thrown = thrownBy(() => {
      AuthLib.requireEnrolment(argsFor('anonymous'));
    });

    expect(isRedirect(thrown)).toBe(true);
    expect(thrown).toMatchObject({
      options: { to: '/login', search: { redirect: '/dashboard?range=7d' } },
    });
  });

  /**
   * `unknown` waits here for the same reason it waits everywhere else, and here the wrong guess
   * costs more than a flash: read as «not scoped», it would bounce somebody who *is* scoped into
   * the shell, where every control answers 403.
   */
  it('waits rather than redirecting while the session is still unknown', () => {
    expect(() => {
      AuthLib.requireEnrolment(argsFor('unknown'));
    }).not.toThrow();
  });
});
