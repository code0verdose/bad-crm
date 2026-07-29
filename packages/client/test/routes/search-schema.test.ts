import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SharedLib } from '@shared';
import { AuthModel } from '@units/auth';
import { DashboardModel } from '@units/dashboard';

/**
 * Search parameters are user input from the address bar: a link in a chat, a bookmark from a
 * previous version, a hand-edited URL. `rules/testing.mdc` §8 asks each schema for the same three
 * cases — rubbish, missing keys, values outside the whitelist — because the failure they prevent is
 * a screen that crashes on a link somebody shared.
 */

/** Resolved from the working directory: this suite runs in jsdom, where `import.meta.url` is http. */
const CLIENT_SRC = resolve(process.cwd(), 'src');

const SORTABLE = ['createdAt', 'title'] as const;

describe('the shared list fields', () => {
  it('fills in the defaults when the URL carries nothing', () => {
    expect(SharedLib.listSearchSchema.parse({})).toEqual({ page: 1, perPage: 25 });
  });

  it('coerces the numeric strings a URL actually contains', () => {
    expect(SharedLib.listSearchSchema.parse({ page: '3', perPage: '50' })).toMatchObject({
      page: 3,
      perPage: 50,
    });
  });

  it('falls back instead of throwing on rubbish', () => {
    expect(SharedLib.listSearchSchema.parse({ page: 'abc', perPage: '10000' })).toMatchObject({
      page: 1,
      perPage: 25,
    });
  });

  it('drops an empty query rather than filtering by an empty string', () => {
    expect(SharedLib.listSearchSchema.parse({ q: '   ' }).q).toBeUndefined();
  });

  it('keeps a real query, trimmed', () => {
    expect(SharedLib.listSearchSchema.parse({ q: '  invoice ' }).q).toBe('invoice');
  });

  it('carries a cursor through for the endpoints that page by one', () => {
    expect(SharedLib.listSearchSchema.parse({ cursor: 'ZW50cnk6NDI' }).cursor).toBe('ZW50cnk6NDI');
  });

  it('drops a blank cursor rather than asking the API to resume from nowhere', () => {
    expect(SharedLib.listSearchSchema.parse({ cursor: '   ' }).cursor).toBeUndefined();
  });
});

/**
 * `sort` reaches an `ORDER BY`, so «any string» is not a validation. The route declares the columns
 * it supports; everything else falls back exactly the way a bad `page` does.
 */
describe('the sort whitelist', () => {
  const schema = SharedLib.listSearchSchemaWithSort(SORTABLE, 'createdAt');

  it('accepts a key the route declared, ascending and descending', () => {
    expect(schema.parse({ sort: 'title' }).sort).toBe('title');
    expect(schema.parse({ sort: '-createdAt' }).sort).toBe('-createdAt');
  });

  it('falls back on a key the route never declared', () => {
    expect(schema.parse({ sort: 'salary' }).sort).toBe('createdAt');
  });

  it('falls back when the URL carries no sort at all', () => {
    expect(schema.parse({}).sort).toBe('createdAt');
  });

  it('still validates the shared fields it was built on', () => {
    expect(schema.parse({ page: '4' })).toMatchObject({ page: 4, sort: 'createdAt' });
  });
});

describe('the dashboard search', () => {
  it('defaults to the personal scope over the last week', () => {
    expect(DashboardModel.dashboardSearchSchema.parse({})).toEqual({ range: '7d', scope: 'me' });
  });

  it('rejects a scope outside the whitelist by falling back to the default', () => {
    expect(DashboardModel.dashboardSearchSchema.parse({ scope: 'everyone' }).scope).toBe('me');
  });

  it('rejects a range outside the whitelist by falling back to the default', () => {
    expect(DashboardModel.dashboardSearchSchema.parse({ range: 'unknown' }).range).toBe('7d');
  });

  it('keeps a whitelisted combination as it was given', () => {
    expect(DashboardModel.dashboardSearchSchema.parse({ range: '30d', scope: 'org' })).toEqual({
      range: '30d',
      scope: 'org',
    });
  });
});

describe('the login search', () => {
  it('has no redirect when the user came to the login page directly', () => {
    expect(AuthModel.loginSearchSchema.parse({})).toEqual({});
  });

  it('keeps a same-origin path to return to', () => {
    expect(AuthModel.loginSearchSchema.parse({ redirect: '/projects/42/board/7' }).redirect).toBe(
      '/projects/42/board/7',
    );
  });

  /**
   * An open redirect through a query parameter is the classic phishing primitive: the link looks
   * like this installation, the login form is real, and the destination is not. Anything that is
   * not a path on this origin is dropped rather than repaired.
   */
  it.each([
    ['an absolute URL', 'https://evil.example/steal'],
    ['a protocol-relative URL', '//evil.example/steal'],
    ['a javascript URL', 'javascript:alert(1)'],
    ['a backslash-smuggled host', String.raw`/\evil.example`],
  ])('drops %s instead of returning the user to it', (_name, redirect) => {
    expect(AuthModel.loginSearchSchema.parse({ redirect }).redirect).toBeUndefined();
  });

  /**
   * The four cases above are all refused by the anchor — `^\/(?![/\\])` — and none of them reaches
   * the character class that follows it. These do, and they are here because the class was added
   * without a case that fails without it: every assertion in this file passed against
   * `[\s\S]*`, which accepts a newline.
   *
   * That the value is only ever handed to `router.navigate` today is not the argument for keeping
   * the class. The argument is that the string is also written to the URL bar and to a log line,
   * and a path holding a raw CR/LF is not a route this application can produce — `location.href`
   * percent-encodes it. So the class costs nothing legitimate and removes a character whose whole
   * significance is that some parser downstream treats it as a terminator.
   */
  it.each([
    ['a line feed', '/dashboard\nx'],
    ['a carriage return', '/dashboard\rx'],
    ['a CRLF pair', '/dashboard\r\nSet-Cookie: a=b'],
    ['a tab', '/dashboard\tx'],
    ['a raw space', '/dash board'],
    ['a NUL byte', '/dashboard\u0000x'],
  ])('drops a path carrying %s', (_name, redirect) => {
    expect(AuthModel.loginSearchSchema.parse({ redirect }).redirect).toBeUndefined();
  });

  it('falls back to one destination the form and the guard agree on', () => {
    expect(AuthModel.POST_LOGIN_PATH).toBe('/dashboard');
  });
});

/**
 * The homes `rules/zod-validation.mdc` rule 11 gives these schemas: reusable primitives in
 * `shared/lib/validation`, domain schemas in the model of the unit that owns them. Asserted against
 * the tree, because the imports above would keep resolving from anywhere — including the
 * `app/search` holding pen they sat in while the units that own them did not exist.
 */
describe('where the search schemas live', () => {
  it('keeps the shared list fields in shared/lib/validation', () => {
    expect(existsSync(`${CLIENT_SRC}/shared/lib/validation/list-search.schema.ts`)).toBe(true);
  });

  it('keeps each domain schema in the model of its own unit', () => {
    expect(existsSync(`${CLIENT_SRC}/units/auth/model/validation/login-search.schema.ts`)).toBe(
      true,
    );
    expect(
      existsSync(`${CLIENT_SRC}/units/dashboard/model/validation/dashboard-search.schema.ts`),
    ).toBe(true);
  });

  it('leaves nothing behind in app/search', () => {
    expect(existsSync(`${CLIENT_SRC}/app/search`)).toBe(false);
  });
});
