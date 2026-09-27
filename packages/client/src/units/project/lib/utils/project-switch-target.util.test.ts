import { describe, expect, it } from 'vitest';

import { projectSwitchTarget } from './project-switch-target.util.js';

const P2 = '018f4a3b-0000-7000-8000-000000000002';

describe('where a project switch lands', () => {
  it.each([
    ['overview', '/projects/$projectId'],
    ['members', '/projects/$projectId/members'],
    ['settings', '/projects/$projectId/settings'],
  ] as const)('keeps the %s section', (section, to) => {
    expect(projectSwitchTarget(P2, section)).toEqual({ to, params: { projectId: P2 } });
  });

  it.each([['files'], ['boards'], ['docs'], ['time']] as const)(
    'lands an unshipped section (%s) on the overview',
    (section) => {
      expect(projectSwitchTarget(P2, section).to).toBe('/projects/$projectId');
    },
  );

  it('lands on the overview from outside a project', () => {
    expect(projectSwitchTarget(P2, null)).toEqual({
      to: '/projects/$projectId',
      params: { projectId: P2 },
    });
  });
});
