import { describe, expect, it } from 'vitest';

import { readSource, sourceFiles } from './source-tree.util.js';

/** The closed dictionary of `rules/naming-and-structure.mdc`, backend half. */
const ROLE_SUFFIXES = new Set([
  'entity',
  'value',
  'errors',
  'policy',
  'port',
  'use-case',
  'query',
  'adapter',
  'repository',
  'client',
  'controller',
  'middleware',
  'routes',
  'validator',
  'serializer',
  'handler',
  'factory',
  'types',
  'schema',
  'enums',
  'constant',
  'util',
  'config',
  'context',
  'store',
]);

/** Names that carry their role in the name itself (rule 3 of the naming rule). */
const FIXED_NAMES = new Set(['index', 'main']);

const basenameOf = (file: string): string => file.split('/').at(-1) ?? '';

const suffixOf = (file: string): string | undefined => {
  const segments = basenameOf(file).replace(/\.ts$/, '').split('.');

  return segments.length > 1 ? segments.at(-1) : undefined;
};

describe('file names', () => {
  it('are kebab-case', () => {
    const wrong = sourceFiles().filter((file) => !/^[a-z0-9./-]+$/.test(basenameOf(file)));

    expect(wrong).toEqual([]);
  });

  it('carry a role suffix from the closed dictionary', () => {
    const wrong = sourceFiles().filter((file) => {
      const stem = basenameOf(file).split('.')[0] ?? '';

      if (FIXED_NAMES.has(stem)) return false;

      const suffix = suffixOf(file);

      return suffix === undefined || !ROLE_SUFFIXES.has(suffix);
    });

    expect(wrong).toEqual([]);
  });

  it('uses .use-case.ts for commands and .query.ts for reads, and nothing else in use-cases/', () => {
    const wrong = sourceFiles()
      .filter((file) => file.includes('/use-cases/'))
      .filter((file) => !file.endsWith('.use-case.ts') && !file.endsWith('.query.ts'));

    expect(wrong).toEqual([]);
  });
});

/**
 * The command/read split is a naming convention with teeth: `*.query.ts` may not change state.
 * Once a read file opens a write transaction, "which files can I reason about as side-effect free"
 * stops having an answer, and the read path starts carrying business rules.
 */
describe('reads do not write', () => {
  const WRITE_MARKERS = [
    /\$transaction\b/,
    /withTransaction\b/,
    /\.save\s*\(/,
    /\.delete\s*\(/,
    /\.create\s*\(/,
    /\.update\s*\(/,
  ];

  const writesIn = (source: string): boolean => WRITE_MARKERS.some((marker) => marker.test(source));

  /** Positive control: the detector has to fail something, or the assertion below proves nothing. */
  it('detects a write in a sample that performs one', () => {
    expect(writesIn('await this.uow.withTransaction(() => this.tasks.save(task));')).toBe(true);
    expect(writesIn('return this.tasks.findMany({ where });')).toBe(false);
  });

  it('finds no write in any *.query.ts', () => {
    const offenders = sourceFiles()
      .filter((file) => file.endsWith('.query.ts'))
      .filter((file) => writesIn(readSource(file)));

    expect(offenders).toEqual([]);
  });
});
