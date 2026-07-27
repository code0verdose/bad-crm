/**
 * Branded identifier types.
 *
 * Type-only surface: the single definition of each id lives in
 * `validation/entity-id.schema.ts`, where the type is inferred from the schema that validates it.
 * Re-exporting the types here gives consumers a place to import an id from without pulling in a
 * runtime schema they do not need — `import type { UserId } from '@bad-crm/shared/types'`.
 */
export type {
  BoardId,
  CommentId,
  DocId,
  FileId,
  OrganizationId,
  ProjectId,
  RoleId,
  SprintId,
  TaskId,
  TeamId,
  TimeEntryId,
  UserId,
} from '../validation/entity-id.schema.js';
