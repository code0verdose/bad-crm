import { describe, expect, it } from 'vitest';

import * as SharedPermissions from '../../packages/shared/src/permissions/index.js';

import { readRepoFile, recordRead } from '../repo/repo-fixture.util.js';

/**
 * The role matrix in code says exactly what §4 of the model document says.
 *
 * Same bridge as the catalogue, and the same reason: the document is where the matrix is designed
 * and reviewed — «does the administrator see money?» is a question about a table somebody reads —
 * while the code is what the product actually grants. A tick that exists in one and not the other is
 * either a permission nobody agreed to hand out or one that was agreed and never arrived.
 *
 * The parser has one subtlety worth naming: a row may abbreviate, listing `` `ai:configure_providers`,
 * `:manage_budget` `` — the shorthand inherits the resource of the key before it. Reading those as
 * two unrelated strings would silently drop every abbreviated key from the comparison, so the
 * expansion is done here and the count is asserted below.
 */

recordRead('packages/shared/src/permissions/system-roles.enums.ts');

const ROLES = ['owner', 'admin', 'manager', 'lead', 'developer', 'viewer', 'guest'] as const;

const documented = (): Record<string, Set<string>> => {
  const document = readRepoFile('docs/security/permission-model.md');
  const section = document.slice(
    document.indexOf('## Системные роли'),
    document.indexOf('### 4.11'),
  );
  const matrix: Record<string, Set<string>> = Object.fromEntries(
    ROLES.map((role) => [role, new Set<string>()]),
  );

  let inTable = false;

  for (const line of section.split('\n')) {
    if (line.startsWith('| Permission |')) {
      inTable = true;
      continue;
    }
    if (inTable && line.startsWith('|---')) continue;
    if (inTable && !line.startsWith('|')) {
      inTable = false;
      continue;
    }
    if (!inTable) continue;

    const cells = line
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((cell) => cell.trim());

    if (cells.length !== ROLES.length + 1) continue;

    const keys: string[] = [];
    let resource: string | undefined;

    for (const [, token] of (cells[0] ?? '').matchAll(/`([^`]+)`/g)) {
      const text = (token ?? '').trim();

      if (text.startsWith(':') && resource !== undefined) keys.push(`${resource}${text}`);
      else if (text.includes(':')) {
        keys.push(text);
        resource = text.split(':')[0];
      }
    }

    ROLES.forEach((role, index) => {
      if ((cells[index + 1] ?? '').includes('✅')) for (const key of keys) matrix[role]?.add(key);
    });
  }

  return matrix;
};

describe('the role matrix and the model document', () => {
  it('CONTROL: the tables really were parsed, abbreviations included', () => {
    const parsed = documented();

    // The owner column is ticked on every row, so its size is the size of the matrix itself.
    expect(parsed['owner']?.size).toBe(SharedPermissions.PERMISSIONS.length);
    expect(parsed['guest']?.size).toBeGreaterThan(0);
  });

  it.each(ROLES)('%s grants the same keys in both places', (role) => {
    const fromDocument = [...(documented()[role] ?? [])].sort();
    const fromCode = [...SharedPermissions.SYSTEM_ROLE_PERMISSIONS[role]].sort();

    expect(fromCode).toEqual(fromDocument);
  });

  /**
   * The sentence the document states in prose about the owner. It said «all 318 keys» while the
   * catalogue held 331 — the number was written once and never measured again, which is exactly what
   * this assertion is for.
   */
  it('matches the owner total the document states in prose', () => {
    const document = readRepoFile('docs/security/permission-model.md');
    const stated = /у него \*\*все (\d+) ключ[а-я]*\*\*/.exec(document);

    expect(stated, 'the document no longer states the owner total').not.toBeNull();
    expect(Number(stated?.[1])).toBe(SharedPermissions.PERMISSIONS.length);
  });
});
