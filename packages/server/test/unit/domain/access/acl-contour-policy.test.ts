import { describe, expect, it } from 'vitest';

import { closeContourOf } from '@/domain/access/acl-contour.policy.js';
import { allow, deny } from '@/domain/access/decision.util.js';

/**
 * The grant routes and the closed contour of a project.
 *
 * `authorizeResource` answers `NONE` on the chain as `acl_explicit_none` — a 403. For a project that
 * is the wrong answer, and the project domain already says so (`closeTheContour` in
 * `project-access.policy.ts`): a `PRIVATE` project is `NONE` for everybody not on it, and «not
 * there» is the only answer that does not confirm it exists. `/acl` reads the same chain for the
 * same object, so without the same remap `GET /acl?resourceType=PROJECT&resourceId=…` would be the
 * oracle the project card is not. The table holds both directions: a project's `NONE` becomes
 * `resource_not_found` with its key kept; the organization's does not, and nothing else moves.
 */

describe('closeContourOf', () => {
  it.each([
    {
      name: 'a project’s NONE reads as not there, the key kept for the denial trail',
      type: 'PROJECT' as const,
      decision: deny('acl_explicit_none', 'acl:read'),
      expected: deny('resource_not_found', 'acl:read'),
    },
    {
      name: 'the organization’s NONE is left as it is — no domain has closed that contour',
      type: 'ORGANIZATION' as const,
      decision: deny('acl_explicit_none', 'acl:grant'),
      expected: deny('acl_explicit_none', 'acl:grant'),
    },
    {
      name: 'a short level on a project is not NONE and stays a 403',
      type: 'PROJECT' as const,
      decision: deny('insufficient_acl_level', 'acl:revoke'),
      expected: deny('insufficient_acl_level', 'acl:revoke'),
    },
    {
      name: 'an allowance passes untouched',
      type: 'PROJECT' as const,
      decision: allow(),
      expected: allow(),
    },
  ])('$name', ({ type, decision, expected }) => {
    expect(closeContourOf(type, decision)).toEqual(expected);
  });
});
