/**
 * @vitest-environment node
 *
 * The package default is `jsdom`, because most of this suite renders components. This file does
 * not: it reads the contract off disk, and under `jsdom` `import.meta.url` is not a `file:` URL, so
 * `fileURLToPath` throws before the first assertion (`test/api/api-schema.test.ts`, same note).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
// The workspace-root `yaml` devDependency, the same one `packages/server/test/contract` reads this
// document with, and deliberately not declared by `packages/client`: nothing under `src/**` parses
// YAML, and adding a dependency to the application so that one test can read a file is the wrong
// trade. `turbo.json` already lists the specification among the `test` task's inputs, so a change
// to it re-runs this suite instead of serving a cached PASS over a document nobody re-read.
import { parse as parseYaml } from 'yaml';

import { SharedValidation } from '@bad-crm/shared';

import { MAX_DESCRIPTION, MAX_NAME, MAX_SLUG, teamFormSchema } from '@units/team/model';

/**
 * What the team form refuses is what `TeamDraft` refuses — asserted, not assumed.
 *
 * `teamFormSchema` states the contract's three bounds and its slug pattern a second time, because
 * the client validates before it sends: a form that submits a value the endpoint then rejects shows
 * an error about the whole request where the person needs one about a field. A second statement of
 * a rule is only safe while something notices the two disagreeing, and until this file nothing did.
 * One of the four is now imported (`MAX_SLUG` is `SharedValidation.SLUG_MAX_LENGTH`); the other
 * three have no shared constant to import — `NAME_MAX`/`DESCRIPTION_MAX` are private to
 * `packages/server/src/presentation/http/validators/team.validator.ts` and the slug pattern is
 * private to `packages/shared/src/validation/slug.schema.ts` — so the specification is the only
 * source the two sides share, and this suite is what turns it into one.
 *
 * The failure this catches is quiet: every existing test uses fixtures built from the constants
 * themselves, so widening `MAX_NAME` to 200 or dropping a character class from the pattern leaves
 * the whole suite green and reaches the user as a `422` with nothing pointing at the field.
 */

const SPEC_PATH = fileURLToPath(new URL('../../../../docs/api/openapi.yaml', import.meta.url));

interface StringSchema {
  readonly maxLength?: number;
  readonly pattern?: string;
}

/** Only the corner of the document this suite reads — named fields, so `tsc` sees no index signature. */
interface TeamDraftProperties {
  readonly name?: StringSchema;
  readonly slug?: StringSchema;
  readonly description?: StringSchema;
}

interface OpenApiDocument {
  readonly components?: {
    readonly schemas?: { readonly TeamDraft?: { readonly properties?: TeamDraftProperties } };
  };
}

const readTeamDraftProperties = (): TeamDraftProperties => {
  const document = parseYaml(readFileSync(SPEC_PATH, 'utf8')) as OpenApiDocument;
  const properties = document.components?.schemas?.TeamDraft?.properties;

  if (properties === undefined) {
    throw new Error(`TeamDraft is no longer an object schema with properties in ${SPEC_PATH}`);
  }

  return properties;
};

const TEAM_DRAFT = readTeamDraftProperties();

const VALID = { name: 'Backend', slug: 'backend', description: '' };

describe('the bounds the form enforces are the bounds the contract publishes', () => {
  const bounds = [
    { field: 'name', constant: MAX_NAME },
    /** Not a number this repository writes twice any more — see the shared-schema case below. */
    { field: 'slug', constant: MAX_SLUG },
    { field: 'description', constant: MAX_DESCRIPTION },
  ] as const;

  // `$field`, not `TeamDraft.$field.maxLength`: `it.each` reads the dotted form as a property path
  // and prints `TeamDraft.undefined` — a failure message that names no field.
  it.each(bounds)('$field stops where the contract says it stops', ({ field, constant }) => {
    expect(TEAM_DRAFT[field]?.maxLength, `TeamDraft.${field}.maxLength in ${SPEC_PATH}`).toBe(
      constant,
    );
  });

  it('takes the slug bound from the shared schema rather than from a third copy', () => {
    expect(MAX_SLUG).toBe(SharedValidation.SLUG_MAX_LENGTH);
  });
});

/**
 * Both directions, on the same list.
 *
 * A corpus of only-rejected values would pass against a pattern that rejects everything, and a
 * corpus of only-accepted ones against a pattern that accepts everything; the list carries both, so
 * a widened pattern (`back_end` slipping through) and a narrowed one (`team-42` refused) each land
 * on a case. No candidate is padded with whitespace: the form trims and the contract does not, and
 * that difference is a normalisation, not a disagreement about what a slug is.
 */
const SLUG_CANDIDATES = [
  'backend',
  'team-42',
  'a',
  '42',
  'back-end-team',
  'back--end',
  'back_end',
  'back end',
  '-backend',
  'backend-',
  'back.end',
  'back/end',
  'Backend',
  'BACKEND',
  'бэкенд',
] as const;

describe('the slug the form accepts is the slug the contract accepts', () => {
  const published = TEAM_DRAFT.slug?.pattern;

  it('publishes a slug pattern at all', () => {
    expect(published, `TeamDraft.slug has no pattern in ${SPEC_PATH}`).toBeDefined();
  });

  it.each(SLUG_CANDIDATES)('agrees about %s', (candidate) => {
    const contract = new RegExp(published ?? '(?!)');

    expect(teamFormSchema.safeParse({ ...VALID, slug: candidate }).success).toBe(
      contract.test(candidate),
    );
  });
});

/**
 * One deliberate divergence, written down instead of left to be discovered.
 *
 * `SharedValidation.slugSchema` lower-cases before it matches, so the server accepts `Backend` and
 * stores `backend`; this form refuses it and says so under the field. Neither behaviour is a bug —
 * the strict one never produces a `422`, and it never renames a team behind the person who typed it
 * — but «the client and the server disagree about `Backend`» is the kind of fact that is either an
 * assertion or a surprise. If the form is ever taught to normalise, or shared to stop, this case is
 * where the decision surfaces.
 */
describe('the form is stricter about case than the shared schema, on purpose', () => {
  it('refuses a slug that the shared schema would silently lower-case', () => {
    expect(SharedValidation.slugSchema.safeParse('Backend')).toMatchObject({
      success: true,
      data: 'backend',
    });

    const result = teamFormSchema.safeParse({ ...VALID, slug: 'Backend' });

    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.message === 'teams.field.slugInvalid')).toBe(
      true,
    );
  });
});
