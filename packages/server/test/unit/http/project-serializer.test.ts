import { describe, expect, it } from 'vitest';

import { type ProjectDetail } from '@/application/project/ports/project-repository.port.js';
import { serializeProjectDetail } from '@/presentation/http/serializers/project.serializer.js';

/**
 * The project serializer is a whitelist, and this file is what keeps it one.
 *
 * `ProjectDetail` is a `ProjectScope`: it carries `isDeleted` so that the **policy** can decide on
 * it, and a serializer that spread its input would put that flag on the wire the day somebody added
 * a field to the read model. The `toEqual` below refuses a key it does not name, so the leak is a
 * red test rather than a contract drift found by a client.
 */

const detail: ProjectDetail = {
  projectId: '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b01',
  key: 'BAD',
  name: 'Bad CRM',
  description: null,
  status: 'ON_HOLD',
  visibility: 'PRIVATE',
  leadId: '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b11',
  color: 'teal',
  memberCount: 3,
  startedAt: new Date('2026-09-01T00:00:00.000Z'),
  dueAt: new Date('2026-12-31T00:00:00.000Z'),
  taskCounter: 42,
  createdAt: new Date('2026-08-30T09:15:00.000Z'),
  isDeleted: false,
};

describe('serializeProjectDetail', () => {
  it('names every field of the contract and nothing the read model carries for the policy', () => {
    expect(serializeProjectDetail(detail)).toEqual({
      id: detail.projectId,
      key: 'BAD',
      name: 'Bad CRM',
      description: null,
      status: 'ON_HOLD',
      visibility: 'PRIVATE',
      leadId: detail.leadId,
      color: 'teal',
      memberCount: 3,
      startedAt: '2026-09-01T00:00:00.000Z',
      dueAt: '2026-12-31T00:00:00.000Z',
      taskCounter: 42,
      createdAt: '2026-08-30T09:15:00.000Z',
    });
  });

  it('keeps absent dates as null rather than as a string of nothing', () => {
    expect(serializeProjectDetail({ ...detail, startedAt: null, dueAt: null })).toMatchObject({
      startedAt: null,
      dueAt: null,
    });
  });

  it('CONTROL: a flag added to the read model does not reach the wire', () => {
    // The whitelist as a property rather than as a list of names: an extra key on the input is
    // invisible on the output, whatever it is called.
    const widened = { ...detail, organizationId: 'leak', isDeleted: true } as ProjectDetail;

    expect(Object.keys(serializeProjectDetail(widened))).not.toContain('organizationId');
    expect(Object.keys(serializeProjectDetail(widened))).not.toContain('isDeleted');
  });
});
