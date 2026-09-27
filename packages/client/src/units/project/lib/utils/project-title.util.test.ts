import { describe, expect, it } from 'vitest';

import { projectTitle } from './project-title.util.js';

describe('how a project names its page', () => {
  it('puts the key before the name', () => {
    expect(projectTitle({ key: 'BAD', name: 'Bad CRM' })).toBe('BAD · Bad CRM');
  });

  it('keeps the name as it was written — data, not a translation', () => {
    expect(projectTitle({ key: 'ОПС', name: 'Операции и склад' })).toBe('ОПС · Операции и склад');
  });
});
