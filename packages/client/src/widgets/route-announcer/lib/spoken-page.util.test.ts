import { describe, expect, it } from 'vitest';

import { crumbName, spokenPage, tabPage } from './spoken-page.util.js';

const project = (pathname: string, title?: string) => ({
  labelKey: 'projects.detail.title',
  ...(title === undefined ? {} : { title }),
  pathname,
  isCurrent: true,
});

const BAD = project('/projects/1', 'BAD · Bad CRM');
const OTH = project('/projects/2', 'OTH · Other project');
const NOT_FOUND = { labelKey: 'errors.not_found.title', pathname: '/projects/2', isCurrent: true };

describe('which page the live region names', () => {
  it('keeps the page it spoke about while the next one loads, unnamed', () => {
    expect(spokenPage(BAD, project('/projects/2'), 'loading')).toBe(BAD);
  });

  it('names the next page once it has arrived', () => {
    expect(spokenPage(BAD, OTH, 'settled')).toBe(OTH);
  });

  it('names a refusal or a failure once it has an answer', () => {
    expect(spokenPage(BAD, NOT_FOUND, 'failed')).toBe(NOT_FOUND);
  });

  it('keeps what it said when the same project is renamed', () => {
    expect(spokenPage(BAD, project('/projects/1', 'BAD · Renamed'), 'settled')).toBe(BAD);
  });

  it('says nothing while the page the tab opened on loads, and names it once it settles', () => {
    expect(spokenPage(undefined, project('/projects/1'), 'loading')).toBeUndefined();
    expect(spokenPage(undefined, BAD, 'settled')).toBe(BAD);
  });

  it('falls silent on a page that names nothing', () => {
    expect(spokenPage(BAD, undefined, 'settled')).toBeUndefined();
    expect(spokenPage(undefined, undefined, 'settled')).toBeUndefined();
  });
});

describe('which page the tab names', () => {
  it('follows a rename of the page it names', () => {
    const renamed = project('/projects/1', 'BAD · Renamed');

    expect(tabPage(BAD, renamed)).toBe(renamed);
  });

  it('keeps the last page while the next one loads, unnamed', () => {
    expect(tabPage(BAD, project('/projects/2'))).toBe(BAD);
  });
});

describe('what a crumb reads as', () => {
  const translate = (key: string) => `t:${key}`;

  it('is its title when it has one, its translated key otherwise, nothing without a crumb', () => {
    expect(crumbName(BAD, translate)).toBe('BAD · Bad CRM');
    expect(crumbName(NOT_FOUND, translate)).toBe('t:errors.not_found.title');
    expect(crumbName(undefined, translate)).toBeUndefined();
  });
});
