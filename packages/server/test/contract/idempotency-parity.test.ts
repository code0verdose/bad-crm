import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { readOpenApiDocument, specOperationEntries } from './openapi-document.util.js';

/**
 * The contract and the registry agree on which operations need `Idempotency-Key`.
 *
 * `rules/api-contract.mdc` §10 asks for the header wherever a retry would do the work twice. Whether
 * a given operation is such a one is a judgement, and it is written down in exactly one place — the
 * specification, where `$ref: '#/components/parameters/IdempotencyKey'` says so. What this file
 * checks is that the running code agrees with that judgement, in both directions.
 *
 * **It was written because the two disagreed.** `POST /invitations/{id}/resend` mints a fresh token,
 * kills the previous one in the same statement and sends a letter — the same nature as
 * `POST /invitations`, which requires the header. The resend did not. A client retrying after a
 * dropped connection got a second token (invalidating the link the first response had already
 * handed over) and the person got a second letter.
 *
 * The parity is asserted rather than a list of «operations that mutate»: what mutates is not
 * mechanically knowable from here, and a second list would drift from the first.
 */

/**
 * Which routes mount the middleware — read out of the registry **source**.
 *
 * Not off the built declarations: `requireIdempotencyKey()` returns an anonymous closure, so at
 * runtime the handler has no name to match on. Reading the source is what the neighbouring gates do
 * for the same reason (`acl-coverage.test.ts`), and it keeps the check honest about what it sees:
 * the literal call in the route's own block.
 */
const REGISTRY_SOURCE = fileURLToPath(
  new URL('../../src/presentation/http/route-registry.factory.ts', import.meta.url),
);

const registryRequires = (): Set<string> => {
  const source = readFileSync(REGISTRY_SOURCE, 'utf8');
  const required = new Set<string>();

  // Blocks are separated by the object literal boundary; each carries at most one `path`.
  for (const block of source.split(/\n\s{4}\{\n/)) {
    const path = /path: `\$\{API_PREFIX\}([^`]*)`/.exec(block)?.[1];
    const method = /method: '(\w+)'/.exec(block)?.[1];

    if (path === undefined || method === undefined) continue;
    if (!block.includes('requireIdempotencyKey()')) continue;

    required.add(`${method.toLowerCase()} ${path.replace(/:(\w+)/g, '{$1}')}`);
  }

  return required;
};

const specDeclares = (): Set<string> =>
  new Set(
    specOperationEntries(readOpenApiDocument())
      .filter((entry) =>
        (entry.operation['parameters'] as { $ref?: string }[] | undefined)?.some(
          (parameter) => parameter.$ref === '#/components/parameters/IdempotencyKey',
        ),
      )
      .map((entry) => `${entry.method.toLowerCase()} ${entry.documentPath}`),
  );

describe('Idempotency-Key, in the contract and in the registry', () => {
  it('CONTROL: both sides name operations, so the comparison is not vacuous', () => {
    expect(specDeclares().size).toBeGreaterThan(0);
    expect(registryRequires().size).toBeGreaterThan(0);
  });

  it('requires the header on exactly the operations the specification declares it for', () => {
    const spec = specDeclares();
    const registry = registryRequires();

    const declaredNotEnforced = [...spec].filter((key) => !registry.has(key)).sort();
    const enforcedNotDeclared = [...registry].filter((key) => !spec.has(key)).sort();

    expect(
      { declaredNotEnforced, enforcedNotDeclared },
      'a retry of one of these does the work twice, or the contract promises a header nobody checks',
    ).toEqual({ declaredNotEnforced: [], enforcedNotDeclared: [] });
  });
});
