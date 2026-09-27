import { describe, expect, it } from 'vitest';

import { importsOf, readSource, sourceFiles } from './source-tree.util.js';

/**
 * An access reader answers with a scope, never with the entity — `rules/hexagonal-backend.mdc` 6,
 * STORY-011-07 acceptance 5, checked against the tree rather than against a reviewer's memory.
 *
 * The failure it exists for is gradual: a reader that returns `{ organizationId, visibility,
 * memberRole }` today grows a `name` next quarter because one screen wanted it, and from then on
 * it is a second repository the policy can decide by — «is the project called X» is not a
 * permission, and a policy that could read it would sooner or later do so (the same reasoning as
 * `effective-permissions-reader.port.ts`: «no email, no name, no status»).
 *
 * Three properties, each on every `*-access-reader.port.ts` under `application`:
 *
 * 1. every method returns a type **declared in the port file itself** (or `null`) — not a
 *    `ProjectDetail`, not an entity from `domain`, not a read model of a repository port;
 * 2. every property of those types is a **decision fact**: an identifier, a flag, a level, a
 *    visibility, a membership role — the closed list below, by name;
 * 3. the port imports **no repository port and no aggregate**, so it cannot return one by alias.
 */

const READER_PORT = /-access-reader\.port\.ts$/;

/**
 * What a policy is allowed to know about an object, by property name.
 *
 * An allow-list rather than a deny-list of entity fields, for the reason `audit-redaction.util.ts`
 * gives the other way round: a deny-list stays quiet on the field nobody thought to list. A new
 * kind of fact — a channel's `kind`, a file's `scope` — is added here, in one line, with the port
 * that needs it. `depth` and `expiresAt` came with `project-audience-access-reader.port.ts`: a
 * grant's node on the chain and its expiry are what the resolution rule reads
 * (`AclEntryOnChain`), not fields of an entity.
 */
const DECISION_FACT =
  /^(organizationId|[a-z]+Id|[a-z]+Ids|is[A-Z]\w*|visibility|memberRole|level|aclLevel|depth|expiresAt)$/;

const stripComments = (source: string): string =>
  source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/\/\/.*$/gm, '');

/** `interface Name { … }` blocks with their bodies, top level only. */
const interfacesIn = (source: string): Map<string, string> => {
  const found = new Map<string, string>();

  for (const match of source.matchAll(/export\s+interface\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) {
    found.set(match[1] ?? '', match[2] ?? '');
  }

  return found;
};

/** Property names of one interface body: `readonly name: T;` → `name`. */
const propertiesOf = (body: string): string[] =>
  [...body.matchAll(/^\s*(?:readonly\s+)?(\w+)\??\s*:/gm)].map((match) => match[1] ?? '');

/** Method signatures `name(...): Promise<T | null>;` → the `T`s. */
const returnedTypes = (body: string): string[] =>
  [...body.matchAll(/\)\s*:\s*Promise<\s*([\s\S]*?)\s*>\s*;/g)].flatMap((match) =>
    (match[1] ?? '')
      .split('|')
      .map((part) => part.trim())
      .filter((part) => part !== 'null' && part !== 'void' && part !== ''),
  );

interface PortShape {
  readonly file: string;
  readonly facts: Map<string, string>;
  readonly ports: Map<string, string>;
}

const shapeOf = (file: string): PortShape => {
  const source = stripComments(readSource(file));
  const interfaces = interfacesIn(source);
  const ports = new Map([...interfaces].filter(([name]) => name.endsWith('Port')));
  const facts = new Map([...interfaces].filter(([name]) => !name.endsWith('Port')));

  return { file, facts, ports };
};

/** The offenders of rule 1: a returned type the port file does not itself declare. */
const foreignReturns = (shape: PortShape): string[] =>
  [...shape.ports.values()].flatMap((body) =>
    returnedTypes(body)
      .filter((type) => !shape.facts.has(type.replace(/^readonly\s+/, '').replace(/\[\]$/, '')))
      .map((type) => `${shape.file} returns ${type}`),
  );

/** The offenders of rule 2: a property that is not a decision fact. */
const entityFields = (shape: PortShape): string[] =>
  [...shape.facts].flatMap(([name, body]) =>
    propertiesOf(body)
      .filter((property) => !DECISION_FACT.test(property))
      .map((property) => `${shape.file}: ${name}.${property}`),
  );

/** The offenders of rule 3: an import that could carry an aggregate or a read model in. */
const aggregateImports = (file: string): string[] =>
  importsOf(file)
    .filter((specifier) => /-repository\.port\.js$|\.entity\.js$|-query\.port\.js$/.test(specifier))
    .map((specifier) => `${file} → ${specifier}`);

const readerPorts = sourceFiles().filter(
  (file) => file.startsWith('application/') && READER_PORT.test(file),
);

describe('access readers answer with facts, never with the entity', () => {
  it('has at least one access reader port, so the assertions below are not vacuous', () => {
    expect(readerPorts.length).toBeGreaterThan(0);
  });

  it.each(readerPorts)('%s returns only types it declares itself', (file) => {
    const shape = shapeOf(file);

    expect(
      shape.ports.size,
      'a *-access-reader.port.ts declares a *Port interface',
    ).toBeGreaterThan(0);
    expect(foreignReturns(shape)).toEqual([]);
  });

  it.each(readerPorts)('%s carries only decision facts — ids, flags, levels, roles', (file) => {
    const shape = shapeOf(file);

    expect(shape.facts.size, 'the facts type is declared beside the port').toBeGreaterThan(0);
    expect(entityFields(shape)).toEqual([]);
  });

  it.each(readerPorts)('%s imports no repository port, read model or aggregate', (file) => {
    expect(aggregateImports(file)).toEqual([]);
  });

  /**
   * Positive control for the three detectors: the shape of the drift they exist for, written out,
   * has to be caught. Without this an `[]` from a regexp that stopped matching would read as «all
   * clean».
   */
  it('CONTROL: flags a reader that grew into a repository', () => {
    const drifted: PortShape = {
      file: 'application/task/ports/task-access-reader.port.ts',
      facts: new Map([
        [
          'TaskAclFacts',
          '\n  readonly organizationId: string;\n  readonly name: string;\n  readonly assigneeIds: readonly string[];\n',
        ],
      ]),
      ports: new Map([
        [
          'TaskAccessReaderPort',
          '\n  aclFacts(id: string): Promise<TaskAclFacts | null>;\n  load(id: string): Promise<Task | null>;\n',
        ],
      ]),
    };

    expect(entityFields(drifted)).toEqual([
      'application/task/ports/task-access-reader.port.ts: TaskAclFacts.name',
    ]);
    expect(foreignReturns(drifted)).toEqual([
      'application/task/ports/task-access-reader.port.ts returns Task',
    ]);
  });

  it('CONTROL: reads the real project reader as the shape it has today', () => {
    const shape = shapeOf('application/access/ports/project-access-reader.port.ts');

    expect([...shape.facts.keys()]).toEqual(['ProjectAclFacts']);
    expect(propertiesOf(shape.facts.get('ProjectAclFacts') ?? '')).toEqual([
      'organizationId',
      'visibility',
      'memberRole',
    ]);
    expect(returnedTypes(shape.ports.get('ProjectAccessReaderPort') ?? '')).toEqual([
      'ProjectAclFacts',
    ]);
  });
});
