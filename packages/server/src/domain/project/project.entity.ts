import {
  type ProjectRole,
  type ProjectStatus,
  type ProjectVisibility,
} from '@/domain/project/project.enums.js';

/**
 * A project as a decision needs it: which row, whether it is still there, and how it is shared.
 *
 * `visibility` travels with the scope because it is the one fact the access policy of STORY-014-03
 * needs beside membership: a non-member of a `PUBLIC_ORG` project is a `VIEWER`, of a `PRIVATE` one
 * is nobody — and «nobody» is answered 404 (`permission-model.md` §5).
 */
export interface ProjectScope {
  readonly projectId: string;
  readonly isDeleted: boolean;
  readonly visibility: ProjectVisibility;
}

/**
 * The project as a **writer** reads it before changing it: the scope, plus every field an audit
 * `before` can name — read under `FOR UPDATE` by `ProjectRepositoryPort.lockForWrite`.
 *
 * Not the detail: no member count, no `taskCounter`, no `createdAt`. A rename's trail entry needs
 * the name it replaced and nothing that costs a join; and a summary that carried the roster would be
 * `TeamDetail`'s mistake over again («one Prisma `include` away from the roster on every rename»).
 */
export interface ProjectSummary extends ProjectScope {
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: ProjectStatus;
  readonly leadId: string;
  readonly startedAt: Date | null;
  readonly dueAt: Date | null;
  readonly color: string;
}

/** The account a membership would be written for — the same shape teams use, for the same TOCTOU. */
export interface ProjectSubject {
  readonly userId: string;
  readonly status: 'ACTIVE' | 'SUSPENDED' | 'INVITED';
}

/** The live membership of one person on one project — the fact the implicit level derives from. */
export interface ProjectMembership {
  readonly projectRole: ProjectRole;
  readonly allocationPct: number;
}
