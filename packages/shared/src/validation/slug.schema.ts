import { z } from 'zod';

/** Lower-case ASCII words joined by single hyphens: `bad-crm`, `team-42`. */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const SLUG_MAX_LENGTH = 64;

/**
 * URL-safe identifier of an organization, project or space.
 *
 * Case and surrounding whitespace are normalised away first — `" Bad-Crm "` and `"bad-crm"` are
 * the same slug, and letting both into the database would produce two organizations with URLs a
 * human cannot tell apart. Anything the pattern still rejects (spaces, double hyphens, non-ASCII)
 * is a genuinely different string, not a formatting accident.
 */
export const slugSchema = z
  .string({ error: 'validation.slug.invalid' })
  .trim()
  .toLowerCase()
  .pipe(
    z
      .string()
      .min(1, { error: 'validation.slug.invalid' })
      .max(SLUG_MAX_LENGTH, { error: 'validation.slug.too_long' })
      .regex(SLUG_PATTERN, { error: 'validation.slug.invalid' }),
  );

export type Slug = z.infer<typeof slugSchema>;
