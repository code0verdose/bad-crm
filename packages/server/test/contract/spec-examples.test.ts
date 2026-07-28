import { describe, expect, it } from 'vitest';

import { readOpenApiDocument } from './openapi-document.util.js';

/**
 * The examples are part of the contract, because they are the part that gets copied.
 *
 * Nobody writes a fixture by reading `format: uuid` off a schema; they copy the value next to it
 * into a seed, a test, a Postman collection. This document shipped identifiers shaped like ULIDs
 * — `01J8Z2F5Q3K9V6N0R4T7YB3XQD` — while every entity key in the product is a `uuid`
 * (`packages/shared/src/validation/entity-id.schema.ts`, `docs/architecture/data-model.md`,
 * «Первичные и внешние ключи»). Nothing failed: the values were free text, and a generated client
 * types them as `string`. The cost lands later, on whoever built a fixture out of one and met
 * `validation.id.invalid`.
 *
 * ULIDs are not banned from the document — `requestId` genuinely is one
 * (`src/infrastructure/platform/system-id-generator.adapter.ts`: ULID for correlation identifiers,
 * UUID for entity keys). That is exactly why the rule is written as "one place, and nowhere else"
 * rather than as "no ULIDs".
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Crockford base32, 26 characters — what `ulid()` produces. */
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Keys whose value is an example rather than a description of one. */
const EXAMPLE_KEYS = new Set(['example', 'examples']);

/** Keys that carry no meaning of their own: the property name is one level further out. */
const TRANSPARENT_KEYS = new Set(['example', 'examples', 'value', 'values']);

interface ExampleValue {
  /** The nearest key that names what the value is — `id`, `requestId`, `slug`. */
  readonly field: string;
  readonly text: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every string inside an example subtree, tagged with the field it illustrates. */
const collectExamples = (node: unknown, field: string, into: ExampleValue[]): void => {
  if (typeof node === 'string') {
    into.push({ field, text: node });

    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) collectExamples(item, field, into);

    return;
  }

  if (!isRecord(node)) return;

  for (const [key, value] of Object.entries(node)) {
    collectExamples(value, TRANSPARENT_KEYS.has(key) ? field : key, into);
  }
};

/** Walks the whole document and hands back every example it declares, wherever it declares it. */
export const exampleValues = (document: unknown, field = ''): ExampleValue[] => {
  const found: ExampleValue[] = [];

  const walk = (node: unknown, context: string): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, context);

      return;
    }

    if (!isRecord(node)) return;

    for (const [key, value] of Object.entries(node)) {
      if (EXAMPLE_KEYS.has(key)) {
        collectExamples(value, context, found);
      } else {
        walk(value, TRANSPARENT_KEYS.has(key) ? context : key);
      }
    }
  };

  walk(document, field);

  return found;
};

/** Schema nodes that declare `format: uuid`, with whatever they offer as an example. */
export const uuidExamples = (document: unknown): ExampleValue[] => {
  const found: ExampleValue[] = [];

  const walk = (node: unknown, field: string): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, field);

      return;
    }

    if (!isRecord(node)) return;

    if (node['format'] === 'uuid') {
      collectExamples({ examples: node['examples'], example: node['example'] }, field, found);
    }

    for (const [key, value] of Object.entries(node)) {
      walk(value, TRANSPARENT_KEYS.has(key) ? field : key);
    }
  };

  walk(document, '');

  return found;
};

describe('the identifiers in the examples are the identifiers of the product', () => {
  it('has examples to judge, so the assertions below are not vacuous', () => {
    expect(exampleValues(readOpenApiDocument()).length).toBeGreaterThan(20);
    expect(uuidExamples(readOpenApiDocument()).length).toBeGreaterThan(0);
  });

  it('illustrates every uuid field with a uuid', () => {
    const wrong = uuidExamples(readOpenApiDocument())
      .filter((entry) => !UUID.test(entry.text))
      .map((entry) => `${entry.field}: ${entry.text}`);

    expect(wrong, 'an example under `format: uuid` that is not one').toEqual([]);
  });

  /**
   * The other direction, and the one that caught the original defect: a ULID-shaped example
   * anywhere it is not a correlation identifier. `requestId` is the only field of this API that
   * carries one.
   */
  it('uses a ULID-shaped example only for a request id', () => {
    const stray = exampleValues(readOpenApiDocument())
      .filter((entry) => ULID.test(entry.text))
      .filter((entry) => entry.field !== 'requestId')
      .map((entry) => `${entry.field}: ${entry.text}`);

    expect(
      stray,
      'entity keys are uuids; a ULID here is copied into a fixture and fails validation later',
    ).toEqual([]);
  });
});

/**
 * The collectors themselves, against the shapes this document actually uses. Both assertions above
 * are "the offending list is empty", which is also what a collector that stopped finding anything
 * returns — and the count check above only proves it finds *something*, not that it reaches the
 * nested `examples: { named: { value: … } }` form that operation-level examples are written in.
 */
describe('reading the examples out of a document', () => {
  it('reads a schema-level example list and keeps the property name', () => {
    const document = {
      components: { schemas: { S: { properties: { id: { examples: ['x'] } } } } },
    };

    expect(exampleValues(document)).toEqual([{ field: 'id', text: 'x' }]);
  });

  it('reaches into a named operation example and keeps the leaf property name', () => {
    const document = {
      paths: {
        '/s': {
          get: {
            responses: {
              '200': {
                content: {
                  'application/json': {
                    examples: { one: { value: { user: { id: 'x' }, requestId: 'y' } } },
                  },
                },
              },
            },
          },
        },
      },
    };

    expect(exampleValues(document)).toEqual([
      { field: 'id', text: 'x' },
      { field: 'requestId', text: 'y' },
    ]);
  });

  it('pairs a uuid format with the example beside it, and ignores formats that are not uuid', () => {
    const document = {
      properties: {
        id: { type: 'string', format: 'uuid', examples: ['x'] },
        when: { type: 'string', format: 'date-time', examples: ['y'] },
      },
    };

    expect(uuidExamples(document)).toEqual([{ field: 'id', text: 'x' }]);
  });

  it('separates the two identifier shapes it exists to keep apart', () => {
    expect(UUID.test('4f1c2f4a-0a6d-4a7b-9a1e-2d3c4b5a6f70')).toBe(true);
    expect(UUID.test('01J8Z2F5Q3K9V6N0R4T7YB3XQD')).toBe(false);
    expect(ULID.test('01J8Z2F5Q3K9V6N0R4T7YB3XQD')).toBe(true);
    expect(ULID.test('4f1c2f4a-0a6d-4a7b-9a1e-2d3c4b5a6f70')).toBe(false);
  });
});
