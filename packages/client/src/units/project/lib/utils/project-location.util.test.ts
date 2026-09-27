import { describe, expect, it } from 'vitest';

import { projectLocation } from './project-location.util.js';

const P1 = '018f4a3b-0000-7000-8000-000000000001';
const ROOT = { routeId: '__root__', params: {} };
const AUTHED = { routeId: '/_authenticated', params: {} };
const LAYOUT = { routeId: '/_authenticated/projects/$projectId', params: { projectId: P1 } };

describe('where the reader stands', () => {
  it.each([
    ['/_authenticated/projects/$projectId/', 'overview'],
    ['/_authenticated/projects/$projectId/members', 'members'],
    ['/_authenticated/projects/$projectId/settings', 'settings'],
  ] as const)('reads the project and the section from %s', (routeId, section) => {
    expect(projectLocation([ROOT, AUTHED, LAYOUT, { routeId, params: { projectId: P1 } }])).toEqual(
      { projectId: P1, section },
    );
  });

  it('reads a project layout without a known section as the overview', () => {
    expect(projectLocation([ROOT, AUTHED, LAYOUT])).toEqual({ projectId: P1, section: 'overview' });
  });

  it.each([
    ['the project list', [ROOT, AUTHED, { routeId: '/_authenticated/projects/', params: {} }]],
    ['a creation form', [ROOT, AUTHED, { routeId: '/_authenticated/projects/new', params: {} }]],
    ['the dashboard', [ROOT, AUTHED, { routeId: '/_authenticated/dashboard', params: {} }]],
  ])('is outside any project on %s', (_where, matches) => {
    expect(projectLocation(matches)).toEqual({ projectId: null, section: null });
  });
});
