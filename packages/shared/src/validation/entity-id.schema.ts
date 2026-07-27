import { z } from 'zod';

/**
 * Branded identifier schemas.
 *
 * Every id is a UUID at runtime and a *distinct type* at compile time, so a `UserId` cannot be
 * passed where a `TaskId` is expected (rules/zod-validation.mdc, rule 10). One mechanism only —
 * Zod's `.brand()` — so there is exactly one definition of `UserId` in the codebase and the type
 * is inferred from the schema instead of being written twice.
 *
 * The list grows with the domain: an id is added here together with the epic that introduces its
 * entity, using the entity name from `docs/product/glossary.md`.
 */
const brandedUuid = <TBrand extends string>() =>
  z.uuid({ error: 'validation.id.invalid' }).brand<TBrand>();

export const organizationIdSchema = brandedUuid<'OrganizationId'>();
export type OrganizationId = z.infer<typeof organizationIdSchema>;

export const userIdSchema = brandedUuid<'UserId'>();
export type UserId = z.infer<typeof userIdSchema>;

export const teamIdSchema = brandedUuid<'TeamId'>();
export type TeamId = z.infer<typeof teamIdSchema>;

export const roleIdSchema = brandedUuid<'RoleId'>();
export type RoleId = z.infer<typeof roleIdSchema>;

export const projectIdSchema = brandedUuid<'ProjectId'>();
export type ProjectId = z.infer<typeof projectIdSchema>;

export const boardIdSchema = brandedUuid<'BoardId'>();
export type BoardId = z.infer<typeof boardIdSchema>;

export const taskIdSchema = brandedUuid<'TaskId'>();
export type TaskId = z.infer<typeof taskIdSchema>;

export const sprintIdSchema = brandedUuid<'SprintId'>();
export type SprintId = z.infer<typeof sprintIdSchema>;

export const commentIdSchema = brandedUuid<'CommentId'>();
export type CommentId = z.infer<typeof commentIdSchema>;

export const docIdSchema = brandedUuid<'DocId'>();
export type DocId = z.infer<typeof docIdSchema>;

export const fileIdSchema = brandedUuid<'FileId'>();
export type FileId = z.infer<typeof fileIdSchema>;

export const timeEntryIdSchema = brandedUuid<'TimeEntryId'>();
export type TimeEntryId = z.infer<typeof timeEntryIdSchema>;

/**
 * Factories for the ids that already have call sites. They `parse` rather than `safeParse`: an id
 * that is not a UUID at this point is a programming error, not user input — user input reaches an
 * id through a request validator, which reports it as `validation_failed`.
 */
export const asOrganizationId = (value: string): OrganizationId =>
  organizationIdSchema.parse(value);
export const asUserId = (value: string): UserId => userIdSchema.parse(value);
export const asProjectId = (value: string): ProjectId => projectIdSchema.parse(value);
export const asTaskId = (value: string): TaskId => taskIdSchema.parse(value);
