import { type SharedPermissions } from '@bad-crm/shared';
import { type ErrorResource } from '@bad-crm/shared/errors';

/**
 * Which translated sentence a refusal about an ACL object is coded as — `PROJECT` → `project_*`.
 *
 * The two catalogues do not have the same shape, on purpose: `ERROR_RESOURCES` is what the client
 * has a sentence for, `ACL_RESOURCE_TYPES` is every kind of object a grant can be about. Where a
 * kind has no sentence of its own, the nearest one is named — a space is phrased as its notes, a
 * folder as its files, a vault as its items — rather than a new `acl_*` code: that code would need
 * an entry in the OpenAPI enumeration and both locale files, and it would tell the caller less
 * than the object's own sentence does. Total by construction (`Record`), so a type added to the
 * shared list without an answer here does not compile.
 *
 * Only `ORGANIZATION` and `PROJECT` can be reached today; the rest are decided now so that the
 * domain that makes them reachable inherits a sentence instead of choosing one under pressure.
 */
const RESOURCE_SENTENCE: Readonly<Record<SharedPermissions.AclResourceType, ErrorResource>> = {
  ORGANIZATION: 'organization',
  PROJECT: 'project',
  BOARD: 'board',
  TASK: 'task',
  DOC_PAGE: 'doc',
  KB_SPACE: 'kb_note',
  KB_NOTE: 'kb_note',
  FILE: 'file',
  FILE_FOLDER: 'file',
  CHANNEL: 'channel',
  VAULT: 'vault_item',
  DASHBOARD: 'dashboard',
};

export const errorResourceOfAclResource = (
  type: SharedPermissions.AclResourceType,
): ErrorResource => RESOURCE_SENTENCE[type];

/** The subject's own sentence: a team that is not here is `team_not_found`, not `project_not_found`. */
const SUBJECT_SENTENCE: Readonly<Record<SharedPermissions.AclSubjectType, ErrorResource>> = {
  USER: 'user',
  ROLE: 'role',
  TEAM: 'team',
};

export const errorResourceOfAclSubject = (type: SharedPermissions.AclSubjectType): ErrorResource =>
  SUBJECT_SENTENCE[type];
