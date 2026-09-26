/**
 * What somebody is on a project — and, through the implicit table, what they may do on it
 * (`LEAD → MANAGER`, `MEMBER → EDITOR`, `REVIEWER → COMMENTER`, `OBSERVER → VIEWER`).
 *
 * The client shows the role; it never derives the level from it. The level is decided on the server
 * over the whole ACL chain, and a second copy of the table here would be a second point of
 * computing rights (risk R-15).
 */
export const PROJECT_ROLES = ['LEAD', 'MEMBER', 'REVIEWER', 'OBSERVER'] as const;

export type ProjectRole = (typeof PROJECT_ROLES)[number];

export const PROJECT_ROLE_LABEL: Readonly<Record<ProjectRole, string>> = {
  LEAD: 'projects.role.LEAD',
  MEMBER: 'projects.role.MEMBER',
  REVIEWER: 'projects.role.REVIEWER',
  OBSERVER: 'projects.role.OBSERVER',
};
