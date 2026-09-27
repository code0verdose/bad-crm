import { describe, expect, it } from 'vitest';

import { leadOptions, projectCandidates } from './project-candidates.util.js';
import { translateFieldErrors } from './translate-field-errors.util.js';

const person = (userId: string, firstName: string) => ({
  userId,
  firstName,
  lastName: 'X',
  email: `${firstName}@example.test`,
});

const PEOPLE = [person('a', 'Anna'), person('b', 'Boris'), person('c', 'Clara')];

describe('projectCandidates', () => {
  it('offers everybody not on the project and not the reader', () => {
    expect(projectCandidates(PEOPLE, ['a'], 'c')).toEqual([{ value: 'b', label: 'Boris X' }]);
  });

  it('offers everybody not on the project when the reader is unknown', () => {
    expect(projectCandidates(PEOPLE, [], undefined).map((c) => c.value)).toEqual(['a', 'b', 'c']);
  });
});

describe('leadOptions', () => {
  it('labels the whole directory, the reader included', () => {
    expect(leadOptions(PEOPLE).map((option) => option.label)).toEqual([
      'Anna X',
      'Boris X',
      'Clara X',
    ]);
  });
});

describe('translateFieldErrors', () => {
  it('translates each field with its values, and skips what is absent', () => {
    const seen: string[] = [];

    expect(
      translateFieldErrors(
        { key: { key: 'k1' }, name: { key: 'k2', values: { count: 3 } } },
        (key, values) => {
          seen.push(JSON.stringify(values));

          return `t:${key}`;
        },
      ),
    ).toEqual({ key: 't:k1', name: 't:k2' });
    expect(seen).toEqual(['{}', '{"count":3}']);
  });

  it('skips a field present with no message', () => {
    expect(translateFieldErrors({ key: undefined }, () => 'never')).toEqual({});
  });
});
