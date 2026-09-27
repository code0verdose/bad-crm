import { describe, expect, it } from 'vitest';

import { visibilityImpactMessage } from './visibility-impact-message.util.js';

describe('visibilityImpactMessage', () => {
  it('closing: counts who loses the project, whatever would be gained', () => {
    expect(visibilityImpactMessage('PRIVATE', { losingAccess: 3, gainingAccess: 9 })).toEqual({
      key: 'projects.visibility.close.impact',
      values: { count: 3 },
    });
  });

  it('opening: counts who gains it, whatever would be lost', () => {
    expect(visibilityImpactMessage('PUBLIC_ORG', { losingAccess: 9, gainingAccess: 1 })).toEqual({
      key: 'projects.visibility.open.impact',
      values: { count: 1 },
    });
  });

  it.each([
    ['PRIVATE', 'projects.visibility.close.impactNone'],
    ['PUBLIC_ORG', 'projects.visibility.open.impactNone'],
  ] as const)('says «nobody» in its own sentence for %s', (target, key) => {
    expect(visibilityImpactMessage(target, { losingAccess: 0, gainingAccess: 0 })).toEqual({ key });
  });
});
