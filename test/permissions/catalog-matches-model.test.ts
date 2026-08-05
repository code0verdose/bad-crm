import { describe, expect, it } from 'vitest';

import * as SharedPermissions from '../../packages/shared/src/permissions/index.js';

import { readRepoFile, recordRead } from '../repo/repo-fixture.util.js';

/**
 * The catalogue in code says exactly what the model document says.
 *
 * `docs/security/permission-model.md` §3 is the source of truth for the *list* — which permissions
 * exist, what each one is scoped to, and which of them are dangerous. `permissions.catalog.ts` is
 * the source of truth for the *type*: a key that does not compile cannot be checked at a call site.
 * Both are needed, so both exist, and this is the bridge that keeps them the same thing.
 *
 * The failure it exists for is quiet and expensive. A key added to the document and not to the code
 * is a permission the product cannot check; a key added to the code and not to the document is a
 * permission nobody reviewed and that no role matrix accounts for. Neither breaks a test that
 * exercises one endpoint, because each such test only knows about its own key.
 *
 * Parsed from the tables rather than from a generated file on purpose: the document is what a person
 * edits when they design a permission, and a gate that reads a generated artefact would be checking
 * the generator.
 */

recordRead('packages/shared/src/permissions/permissions.catalog.ts');

const CATALOG_SECTION_START = '## Полный каталог permissions';
const CATALOG_SECTION_END = '### 3.19 Правила именования';

/** `| \`key\` | resource | action | ACL | dangerous | domain |` */
const ROW = /^\|\s*`([a-z0-9_]+:[a-z0-9_]+)`\s*\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|/gm;

interface DocumentedPermission {
  readonly key: string;
  readonly resource: string;
  readonly action: string;
  readonly requiredLevel: string | null;
  readonly dangerous: boolean;
  readonly domain: string;
}

const documented = (): DocumentedPermission[] => {
  const document = readRepoFile('docs/security/permission-model.md');
  const section = document.slice(
    document.indexOf(CATALOG_SECTION_START),
    document.indexOf(CATALOG_SECTION_END),
  );

  return [...section.matchAll(ROW)].map(([, key, resource, action, acl, dangerous, domain]) => {
    const level = (acl ?? '').trim();

    return {
      key: key ?? '',
      resource: (resource ?? '').trim(),
      action: (action ?? '').trim(),
      requiredLevel: level === '—' || level === '' ? null : level,
      dangerous: (dangerous ?? '').includes('**да**'),
      domain: (domain ?? '').trim(),
    };
  });
};

const inCode = (key: string): DocumentedPermission | undefined => {
  if (!SharedPermissions.isPermissionKey(key)) return undefined;

  const meta = SharedPermissions.PERMISSION_META[key];

  return {
    key,
    resource: meta.resource,
    action: meta.action,
    requiredLevel: meta.requiredLevel,
    dangerous: meta.dangerous,
    domain: meta.domain,
  };
};

describe('the catalogue and the model document', () => {
  it('CONTROL: the document really was parsed', () => {
    // Against an empty parse every comparison below passes: a renamed heading, an edited table
    // format, and the gate reports agreement between the code and nothing at all.
    expect(documented().length).toBeGreaterThan(300);
  });

  it('name the same keys', () => {
    const fromDocument = documented().map((permission) => permission.key);
    const fromCode = [...SharedPermissions.PERMISSIONS];

    expect([...fromDocument].sort()).toEqual([...fromCode].sort());
  });

  it('agree on every field of every key', () => {
    const disagreements = documented().flatMap((expected) => {
      const actual = inCode(expected.key);

      return actual === undefined || JSON.stringify(actual) === JSON.stringify(expected)
        ? []
        : [{ key: expected.key, document: expected, code: actual }];
    });

    expect(disagreements).toEqual([]);
  });

  /**
   * The two numbers the document states in prose. They are what a reviewer sees in a diff, and a
   * catalogue that grew by one while the sentence stayed is exactly how «318 keys» became folklore.
   */
  it('match the totals the document states', () => {
    const document = readRepoFile('docs/security/permission-model.md');
    const stated = /\*\*Итого: (\d+) ключ[а-я]*, из них (\d+) отмечены `isDangerous`/.exec(document);

    expect(stated, 'the document no longer states its totals').not.toBeNull();

    const dangerous = [...SharedPermissions.PERMISSIONS].filter(
      (key) => SharedPermissions.PERMISSION_META[key].dangerous,
    );

    expect(Number(stated?.[1])).toBe(SharedPermissions.PERMISSIONS.length);
    expect(Number(stated?.[2])).toBe(dangerous.length);
  });
});

/**
 * The refusal reasons say the same thing in both places, for the same reason the keys do: the list
 * lives in the document as a decision and in the code as a type, and a reason present in one and not
 * the other is a refusal nobody can translate or filter for.
 */
describe('the deny reasons and the model document', () => {
  it('name the same reasons', () => {
    const document = readRepoFile('docs/security/permission-model.md');
    const block = /export const DENY_REASONS = \[([\s\S]*?)\] as const;/.exec(document);

    expect(block, 'the document no longer declares DENY_REASONS').not.toBeNull();

    const documented = [...(block?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map(([, reason]) => reason);

    expect(documented.length).toBeGreaterThan(10);
    expect([...documented].sort()).toEqual([...SharedPermissions.DENY_REASONS].sort());
  });
});
