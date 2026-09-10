import { type ProjectMemberEntry } from '@/application/project/ports/project-member-repository.port.js';
import { type ProjectDetail } from '@/application/project/ports/project-repository.port.js';
import {
  type ProjectRole,
  type ProjectStatus,
  type ProjectVisibility,
} from '@/domain/project/project.enums.js';

/**
 * One project → the `ProjectDetail` schema of `docs/api/openapi.yaml`.
 *
 * A whitelist, field by field, rather than a spread of the read model: `ProjectDetail` is a
 * `ProjectScope` and carries `isDeleted` so that the **policy** can decide on it, and a serializer
 * that spread its input would put that flag on the wire the day somebody added a field. The unit
 * test holds the list with `toEqual`, so a key this file does not name never leaves the process.
 *
 * No `permissions` block yet. STORY-014-05 asks for `{ canEdit, canManageMembers, canArchive }`
 * on the DTO (STORY-011-08, acceptance 12); it did not arrive with the write routes either — the
 * levels those three read are decided by policies that now exist, but a block on the read DTO is
 * the card's half (STORY-014-05), and this delta is the routes' (STORY-014-01/02).
 */
export interface ProjectDetailResponse {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: ProjectStatus;
  readonly visibility: ProjectVisibility;
  readonly leadId: string;
  readonly color: string;
  readonly memberCount: number;
  readonly startedAt: string | null;
  readonly dueAt: string | null;
  readonly taskCounter: number;
  readonly createdAt: string;
}

export const serializeProjectDetail = (project: ProjectDetail): ProjectDetailResponse => ({
  id: project.projectId,
  key: project.key,
  name: project.name,
  description: project.description,
  status: project.status,
  visibility: project.visibility,
  leadId: project.leadId,
  color: project.color,
  memberCount: project.memberCount,
  startedAt: project.startedAt === null ? null : project.startedAt.toISOString(),
  dueAt: project.dueAt === null ? null : project.dueAt.toISOString(),
  taskCounter: project.taskCounter,
  createdAt: project.createdAt.toISOString(),
});

/**
 * One membership → the `ProjectMember` schema. A user id and no name, as the team roster: who this
 * account belongs to is the directory, behind its own permission.
 */
export interface ProjectMemberResponse {
  readonly userId: string;
  readonly projectRole: ProjectRole;
  readonly allocationPct: number;
  readonly joinedAt: string;
  readonly leftAt: string | null;
}

export const serializeProjectMember = (member: ProjectMemberEntry): ProjectMemberResponse => ({
  userId: member.userId,
  projectRole: member.projectRole,
  allocationPct: member.allocationPct,
  joinedAt: member.joinedAt.toISOString(),
  leftAt: member.leftAt === null ? null : member.leftAt.toISOString(),
});
