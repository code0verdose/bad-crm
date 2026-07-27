import type { ErrorCode } from '@bad-crm/shared';

export interface TaskSnapshot {
  readonly organizationId: string;
  readonly title: string;
}

export class Task {
  constructor(private readonly snapshot: TaskSnapshot) {}

  rename(title: string): Task {
    return new Task({ ...this.snapshot, title });
  }

  describe(): string {
    return this.snapshot.title;
  }
}

export const notFound: ErrorCode = 'resource_not_found';
