import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SharedLib } from '@shared';
import { AuthModel } from '@units/auth';
import { DashboardModel } from '@units/dashboard';
import { EmployeeModel } from '@units/employee';
import { IamModel } from '@units/iam';
import { TeamModel } from '@units/team';

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

/**
 * The directory's filter is the widest search schema in the client, and the one most likely to be
 * hand-edited: it is what a shared link carries. Every field falls back rather than failing, because
 * a rejected `validateSearch` replaces the screen with the error boundary — and with `replace: true`
 * on every filter change the broken address stays in the bar, so a reload does not help either.
 */
describe('the directory search', () => {
  it('starts from everybody, page one, ordered by surname', () => {
    expect(EmployeeModel.memberListSearchSchema.parse({})).toEqual({
      q: '',
      status: [],
      role: [],
      team: [],
      sort: 'name',
      page: 1,
      view: 'table',
    });
  });

  it('keeps a filter somebody actually selected', () => {
    const id = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5ae1';

    expect(
      EmployeeModel.memberListSearchSchema.parse({
        q: ' ив ',
        status: ['SUSPENDED'],
        role: [id],
        sort: '-hiredAt',
        page: '4',
        view: 'chart',
      }),
    ).toMatchObject({
      q: 'ив',
      status: ['SUSPENDED'],
      role: [id],
      sort: '-hiredAt',
      page: 4,
      view: 'chart',
    });
  });

  it.each([
    ['a status that is not one', { status: ['RETIRED'] }, 'status', []],
    ['an order by a column nobody exposed', { sort: 'salary' }, 'sort', 'name'],
    ['a page that is a word', { page: 'last' }, 'page', 1],
    ['a page before the first', { page: '0' }, 'page', 1],
    ['a view that does not exist', { view: 'gantt' }, 'view', 'table'],
    ['a role filter that is not an id', { role: ['../etc/passwd'] }, 'role', []],
  ])('falls back on %s', (_name, input, field, expected) => {
    expect(
      EmployeeModel.memberListSearchSchema.parse(input)[
        field as keyof EmployeeModel.MemberListSearch
      ],
    ).toEqual(expected);
  });

  it('drops the whole list when one id in it is rubbish', () => {
    // `.catch` on the array, not on the item: a partially accepted filter would silently narrow the
    // list to something nobody asked for, which is worse than the unfiltered answer.
    const id = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5ae1';

    expect(EmployeeModel.memberListSearchSchema.parse({ team: [id, 'nonsense'] }).team).toEqual([]);
  });
});

/**
 * The team list carries three parameters and no ids, which is the whole difference from the
 * directory next door: `GET /teams` accepts nothing, so the phrase, the order and the page are
 * applied to the answer. They live in the URL for the same reasons anyway — a reload, a back button
 * and a link to «команды по размеру» are properties of the screen, not of the request.
 */
describe('the team search', () => {
  it('starts from everything, page one, ordered by name', () => {
    expect(TeamModel.teamListSearchSchema.parse({})).toEqual({ q: '', sort: 'name', page: 1 });
  });

  it('keeps what somebody actually chose', () => {
    expect(
      TeamModel.teamListSearchSchema.parse({ q: '  back ', sort: '-members', page: '2' }),
    ).toEqual({ q: 'back', sort: '-members', page: 2 });
  });

  it.each([
    ['an order by a column nobody exposed', { sort: 'budget' }, 'sort', 'name'],
    ['a page that is a word', { page: 'last' }, 'page', 1],
    ['a page before the first', { page: '0' }, 'page', 1],
    ['a fractional page', { page: '1.5' }, 'page', 1],
    ['a phrase somebody pasted an essay into', { q: 'x'.repeat(200) }, 'q', ''],
  ])('falls back on %s', (_name, input, field, expected) => {
    expect(
      TeamModel.teamListSearchSchema.parse(input)[field as keyof TeamModel.TeamListSearch],
    ).toEqual(expected);
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
 * The permissions tab of a personnel card (STORY-011-11): which face is open, and how the catalogue
 * of three hundred keys is narrowed. Every field falls back rather than failing, for the reason the
 * directory's does — this is what a shared link carries.
 */
describe('the personnel card search', () => {
  it('opens the profile when the URL says nothing', () => {
    expect(IamModel.userPermissionsSearchSchema.parse({})).toEqual({
      tab: 'profile',
      q: '',
      exceptions: false,
    });
  });

  it('opens the permissions tab when the URL asks for it', () => {
    expect(IamModel.userPermissionsSearchSchema.parse({ tab: 'roles' }).tab).toBe('roles');
  });

  it('falls back to the profile on a tab that does not exist, rather than rendering no body', () => {
    expect(IamModel.userPermissionsSearchSchema.parse({ tab: 'salary' }).tab).toBe('profile');
  });

  it('trims the phrase and drops one somebody pasted an essay into', () => {
    expect(IamModel.userPermissionsSearchSchema.parse({ q: '  task:up ' }).q).toBe('task:up');
    expect(
      IamModel.userPermissionsSearchSchema.parse({ q: 'x'.repeat(500) }).q,
      'a phrase past the cap falls back to «no filter», it does not truncate to something nobody typed',
    ).toBe('');
  });

  it.each([
    ['the string true', 'true', true],
    ['the string false', 'false', false],
    // The case `z.coerce.boolean()` gets wrong: every non-empty string is truthy, so `?exceptions=no`
    // would switch the filter **on** — the opposite of what it says.
    ['a word that is neither', 'no', false],
    ['a number', '1', false],
  ])('reads %s as a decision the URL can actually carry', (_case, exceptions, expected) => {
    expect(IamModel.userPermissionsSearchSchema.parse({ exceptions }).exceptions).toBe(expected);
  });

  /**
   * The property that keeps `Link to="/admin/members/$userId"` compiling in the directory, which has
   * no opinion about tabs: `catch` handles a value that is present and wrong, `default` one that is
   * absent, and without the second every field would be required of every caller.
   */
  it('asks nothing of a caller who links to the card without any of it', () => {
    expect(IamModel.userPermissionsSearchSchema.parse({})).toBeDefined();
    expect(Object.keys(IamModel.userPermissionsSearchSchema.parse({})).sort()).toEqual([
      'exceptions',
      'q',
      'tab',
    ]);
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
    expect(
      existsSync(`${CLIENT_SRC}/units/employee/model/validation/member-list-search.schema.ts`),
    ).toBe(true);
    expect(existsSync(`${CLIENT_SRC}/units/team/model/validation/team-list-search.schema.ts`)).toBe(
      true,
    );
    expect(
      existsSync(`${CLIENT_SRC}/units/iam/model/validation/user-permissions-search.schema.ts`),
    ).toBe(true);
  });

  it('leaves nothing behind in app/search', () => {
    expect(existsSync(`${CLIENT_SRC}/app/search`)).toBe(false);
  });
});
