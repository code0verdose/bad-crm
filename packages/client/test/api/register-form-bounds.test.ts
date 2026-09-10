/**
 * @vitest-environment node
 *
 * The package default is `jsdom`, because most of this suite renders components. This file does
 * not: it reads the contract off disk, and under `jsdom` `import.meta.url` is not a `file:` URL, so
 * `fileURLToPath` throws before the first assertion (`test/api/team-form-bounds.test.ts`, same note).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
// The workspace-root `yaml` devDependency, as in the sibling file — nothing under `src/**` parses
// YAML, and `turbo.json` already lists the specification among the `test` task's inputs, so a
// change to it re-runs this suite instead of serving a cached PASS over a document nobody re-read.
import { parse as parseYaml } from 'yaml';

import { SharedValidation } from '@bad-crm/shared';

import {
  MAX_ORGANIZATION_NAME,
  MAX_ORGANIZATION_SLUG,
  registerFormSchema,
} from '@units/auth/model';

/**
 * What the registration form refuses is what `RegisterOrganizationRequest` refuses — asserted, not
 * assumed.
 *
 * The form states the contract's name bound and its slug pattern a second time, because it
 * validates before it sends: this is the one screen whose user has no account, so a value the form
 * accepts and the endpoint rejects comes back as a sentence about the whole request instead of a
 * message under the field that has to change. A second statement of a rule is only safe while
 * something notices the two disagreeing, and this is that something.
 *
 * The password is **not** restated anywhere: the form applies `SharedValidation.newPasswordSchema`
 * — the bounds of `passwordSchema`, which the server validator applies, plus the shape check the
 * server's use-case applies — both from one shared source, so there is nothing here for a test to
 * compare.
 */
const SPEC_PATH = fileURLToPath(new URL('../../../../docs/api/openapi.yaml', import.meta.url));

interface StringSchema {
  readonly maxLength?: number;
  readonly pattern?: string;
}

interface OpenApiDocument {
  readonly components?: {
    readonly schemas?: {
      readonly OrganizationSlug?: StringSchema;
      readonly RegisterOrganizationRequest?: {
        readonly properties?: {
          readonly organization?: { readonly properties?: { readonly name?: StringSchema } };
        };
      };
    };
  };
}

const document = parseYaml(readFileSync(SPEC_PATH, 'utf8')) as OpenApiDocument;

const organizationName = (): StringSchema => {
  const schema =
    document.components?.schemas?.RegisterOrganizationRequest?.properties?.organization?.properties
      ?.name;

  if (schema === undefined) {
    throw new Error(`RegisterOrganizationRequest.organization.name is gone from ${SPEC_PATH}`);
  }

  return schema;
};

const organizationSlug = (): StringSchema => {
  const schema = document.components?.schemas?.OrganizationSlug;

  if (schema === undefined) throw new Error(`OrganizationSlug is gone from ${SPEC_PATH}`);

  return schema;
};

const VALID = {
  organizationName: 'Bad Company',
  slug: 'bad-company',
  email: 'ada@example.com',
  password: 'correct-horse-battery',
  confirmPassword: 'correct-horse-battery',
};

const accepts = (patch: Partial<typeof VALID>): boolean =>
  registerFormSchema.safeParse({ ...VALID, ...patch }).success;

describe('the bounds the registration form enforces are the bounds the contract publishes', () => {
  it('caps the organization name where the contract caps it', () => {
    expect(organizationName().maxLength).toBe(MAX_ORGANIZATION_NAME);
  });

  it('takes the slug bound from the shared schema rather than from a third copy', () => {
    expect(MAX_ORGANIZATION_SLUG).toBe(SharedValidation.SLUG_MAX_LENGTH);
    expect(organizationSlug().maxLength).toBe(MAX_ORGANIZATION_SLUG);
  });
});

/**
 * Both directions on one corpus. A list of only-rejected values would pass against a pattern that
 * rejects everything, and a list of only-accepted ones against a pattern that accepts everything —
 * so a widened pattern (`bad_company` slipping through) and a narrowed one (`team-42` refused) each
 * land on a case, and each case is checked against the specification rather than against a belief
 * about it.
 */
const SLUG_CANDIDATES = [
  'bad-company',
  'team-42',
  'a',
  '42',
  'bad-company-two',
  'bad--company',
  'bad_company',
  'bad company',
  '-bad',
  'bad-',
  'bad.company',
  'Bad-Company',
  'BADCOMPANY',
  'компания',
];

describe('the slug the form accepts is the slug the contract describes', () => {
  const pattern = new RegExp(organizationSlug().pattern ?? '(?!)', 'u');

  it('CONTROL: the corpus exercises both answers', () => {
    expect(SLUG_CANDIDATES.some((slug) => pattern.test(slug))).toBe(true);
    expect(SLUG_CANDIDATES.some((slug) => !pattern.test(slug))).toBe(true);
  });

  it.each(SLUG_CANDIDATES)('agrees with the contract about %s', (slug) => {
    expect(accepts({ slug })).toBe(pattern.test(slug));
  });

  it('refuses a slug one character past the bound and accepts one at it', () => {
    expect(accepts({ slug: 'a'.repeat(MAX_ORGANIZATION_SLUG) })).toBe(true);
    expect(accepts({ slug: 'a'.repeat(MAX_ORGANIZATION_SLUG + 1) })).toBe(false);
  });

  it('refuses a name one character past the bound and accepts one at it', () => {
    expect(accepts({ organizationName: 'x'.repeat(MAX_ORGANIZATION_NAME) })).toBe(true);
    expect(accepts({ organizationName: 'x'.repeat(MAX_ORGANIZATION_NAME + 1) })).toBe(false);
  });
});
