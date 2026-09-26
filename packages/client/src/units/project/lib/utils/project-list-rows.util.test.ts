import { describe, expect, it } from 'vitest';

import { projectLeadOptions, projectListRows } from './project-list-rows.util.js';

const ANNA = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b11';
const HIDDEN = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b12';
const NAMELESS = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b13';

const people = [
  { userId: ANNA, firstName: 'Anna', lastName: 'Ivanova', email: 'anna@example.test' },
  // An account whose personnel record nobody has filled in yet.
  { userId: NAMELESS, firstName: '', lastName: '', email: 'new@example.test' },
];

describe('projectListRows', () => {
  it('names the lead from the directory and keeps every field of the item', () => {
    expect(projectListRows([{ id: 'p-1', leadId: ANNA }], people)).toEqual([
      { id: 'p-1', leadId: ANNA, leadLabel: 'Anna Ivanova' },
    ]);
  });

  it('falls back to the e-mail for a person with no name yet', () => {
    expect(projectListRows([{ leadId: NAMELESS }], people)[0]?.leadLabel).toBe('new@example.test');
  });

  it('shows the id of a lead the reader may not be told about, never a blank', () => {
    expect(projectListRows([{ leadId: HIDDEN }], people)[0]?.leadLabel).toBe(HIDDEN);
    expect(projectListRows([{ leadId: ANNA }], [])[0]?.leadLabel).toBe(ANNA);
  });
});

describe('projectLeadOptions', () => {
  it('offers exactly the facet, in its order, each named where it can be', () => {
    expect(projectLeadOptions([HIDDEN, ANNA], people)).toEqual([
      { value: HIDDEN, label: HIDDEN },
      { value: ANNA, label: 'Anna Ivanova' },
    ]);
  });
});
