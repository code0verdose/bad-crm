/**
 * The project key — the prefix of every task number of the project (`BAD-14`).
 *
 * Stored **already normalized**: `ck_projects_key_format` on `projects.key` refuses anything that
 * does not match the pattern below, so a raw write cannot skip the normalization this file performs
 * and two spellings of one key cannot both exist. The pattern is the migration's, character for
 * character; `project-key-value.test.ts` holds the two together.
 *
 * Normalization is `trim` + upper-case and nothing cleverer: `" bad "` is `BAD` (STORY-014-01,
 * acceptance 2), `"b a d"` is refused rather than squeezed — a key a person did not type is a key a
 * person cannot find.
 *
 * Immutable after creation by construction rather than by rule: `ProjectPatch` has no `key`, the
 * update schema refuses one as an unknown field, and no repository method changes it.
 */
export const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;

export const normalizeProjectKey = (raw: string): string => raw.trim().toUpperCase();

export const isProjectKey = (value: string): boolean => PROJECT_KEY_PATTERN.test(value);
