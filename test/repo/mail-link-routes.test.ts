import { describe, expect, it } from 'vitest';

import { readRepoFile, repoEntryNames } from './repo-fixture.util.js';

const MAIL_TEMPLATE = 'packages/server/src/domain/identity/password-reset-mail.util.ts';
const CLIENT_ROUTES = 'packages/client/src/app/routes';

/**
 * The path in a password-reset letter and the route that answers it live in different packages.
 *
 * The server composes `${appUrl}/reset-password/${token}` in `password-reset-mail.util.ts`; the
 * client answers it with the file route `reset-password.$token.tsx`. Nothing else connects the two
 * strings. Renaming the route file — to `$resetToken`, into a nested folder, to a query parameter —
 * leaves both suites green: the server test asserts the string the server itself builds, the client
 * test renders the route the client itself declares, and neither is wrong about its own half.
 *
 * What breaks is observable only in a mailbox, and only after a release: every link already sent
 * lands on the not-found screen — for the one flow whose users are by definition unable to sign in
 * and report it from inside the product.
 *
 * The segment is read out of the template rather than restated here, so that this test cannot agree
 * with a copy of the string while disagreeing with the shipped one.
 */
describe('the password reset link', () => {
  it('points at a route the client declares', () => {
    const segment = mailPathSegment();

    expect(
      repoEntryNames(CLIENT_ROUTES),
      `the letter links to /${segment}/<token>, which no client route file answers`,
    ).toContain(`${segment}.$token.tsx`);
  });
});

const mailPathSegment = (): string => {
  const match = /\$\{input\.appUrl\.replace\([^)]*\)\}\/([\w-]+)\/\$\{input\.token\}/.exec(
    readRepoFile(MAIL_TEMPLATE),
  );

  expect(
    match,
    `the reset link in ${MAIL_TEMPLATE} is no longer a literal this test can read`,
  ).not.toBeNull();

  return match![1];
};
