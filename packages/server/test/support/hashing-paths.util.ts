import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** `packages/server/src`, resolved from this file rather than from the working directory. */
const SOURCE_ROOT = fileURLToPath(new URL('../../src', import.meta.url));

/**
 * The one primitive that costs Argon2id, and therefore the one seed the closure below grows from.
 *
 * Everything in this codebase that runs Argon2id runs it through `PasswordHasherPort` —
 * `LimitedPasswordHasher` wraps that port with the concurrency ceiling, and the recovery-code
 * generator hashes by holding the same port rather than by reaching the library itself. Naming the
 * port is therefore naming the whole of the hashing surface; naming *paths* would be the hand-kept
 * list this file exists to replace.
 */
const HASHING_SEED = 'PasswordHasherPort';

/** A class declared in `src`, reduced to what the reachability question needs. */
interface DeclaredClass {
  readonly name: string;
  /** The interfaces after `implements`, so that reaching an adapter also reaches its port. */
  readonly implemented: readonly string[];
  /** The types its constructor takes — how a collaborator is reached in this codebase. */
  readonly injected: readonly string[];
}

const typeScriptFilesUnder = async (directory: string): Promise<string[]> => {
  const found: string[] = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);

    if (entry.isDirectory()) found.push(...(await typeScriptFilesUnder(absolute)));
    else if (entry.name.endsWith('.ts')) found.push(absolute);
  }

  return found;
};

const declaredClassesIn = (source: string): DeclaredClass[] =>
  [...source.matchAll(/export class (\w+)(?:[^{]*?implements ([^{]+))?\s*\{/g)].map((match) => {
    const constructorAt = source.indexOf('constructor(', match.index);
    const signature =
      constructorAt < 0 ? '' : source.slice(constructorAt, source.indexOf('{', constructorAt));

    return {
      name: match[1] ?? '',
      implemented: (match[2] ?? '')
        .split(',')
        .map((name) => name.trim().replace(/<.*/, ''))
        .filter((name) => name.length > 0),
      injected: [...signature.matchAll(/:\s*([A-Z]\w+)/g)].map((param) => param[1] ?? ''),
    };
  });

/** Every type name from which an Argon2id computation is reachable, seeded and then closed over. */
const hashingTypesOf = (sources: ReadonlyMap<string, string>): ReadonlySet<string> => {
  const declared = [...sources.values()].flatMap(declaredClassesIn);
  const hashing = new Set([HASHING_SEED]);

  // A class that is handed something hashing can hash, and so can whatever port it presents itself
  // as. Repeated until nothing new is added: the chain is `PasswordHasherPort` →
  // `CsprngRecoveryCodeGenerator` → `RecoveryCodeGeneratorPort` → `GenerateRecoveryCodesUseCase` →
  // its callers, and a fixed number of passes would be a guess at how long that chain may get.
  for (let added = true; added;) {
    added = false;

    for (const declaration of declared) {
      if (hashing.has(declaration.name)) continue;
      if (!declaration.injected.some((type) => hashing.has(type))) continue;

      hashing.add(declaration.name);
      for (const port of declaration.implemented) hashing.add(port);
      added = true;
    }
  }

  return hashing;
};

/** The body of `async <name>(`, brace-matched — enough to ask what happens in `execute` and where. */
export const methodBodyOf = (source: string, name: string): string => {
  const declaredAt = source.indexOf(`async ${name}(`);

  if (declaredAt < 0) return '';

  const opened = source.indexOf('{', declaredAt);
  let depth = 0;

  for (let cursor = opened; cursor < source.length; cursor += 1) {
    if (source[cursor] === '{') depth += 1;
    else if (source[cursor] === '}') {
      depth -= 1;

      if (depth === 0) return source.slice(opened, cursor + 1);
    }
  }

  return source.slice(opened);
};

/** One use-case that spends a rate-limit point on a path from which Argon2id is reachable. */
export interface HashingPath {
  /** Relative to `packages/server`, so a failure names something a reader can open. */
  readonly file: string;
  readonly source: string;
  /**
   * The constructor properties through which this use-case reaches hashing — the receivers whose
   * calls have to sit inside the refund wrapper rather than before it.
   */
  readonly hashingCollaborators: readonly string[];
}

/**
 * Every use-case that spends a rate-limit point and can reach Argon2id — derived, never listed.
 *
 * The walk is the point. A hand-written list of paths passes on the day somebody adds an eleventh
 * one and forgets it, which is precisely the failure the refund wrapper exists to be protected
 * from; this reads `src` instead, so the eleventh path is on the list the moment it is written.
 */
export const pathsThatSpendBeforeHashing = async (): Promise<HashingPath[]> => {
  const files = await typeScriptFilesUnder(SOURCE_ROOT);
  const sources = new Map<string, string>();

  for (const file of files) sources.set(file, await readFile(file, 'utf8'));

  const hashing = hashingTypesOf(sources);
  const collected: HashingPath[] = [];

  for (const [file, source] of sources) {
    if (!file.includes(`${path.sep}use-cases${path.sep}`)) continue;
    if (!/\brateLimit\.consume\(/.test(source)) continue;

    const collaborators = [...source.matchAll(/readonly (\w+):\s*([A-Z]\w+)/g)]
      .filter((property) => hashing.has(property[2] ?? ''))
      .map((property) => property[1] ?? '');

    if (collaborators.length === 0) continue;

    collected.push({
      file: path.relative(path.join(SOURCE_ROOT, '..'), file),
      source,
      hashingCollaborators: collaborators,
    });
  }

  return collected.sort((left, right) => left.file.localeCompare(right.file));
};

/**
 * Every file under `src` that calls the refund wrapper, found by text rather than by reachability.
 *
 * The reverse of the derivation above, and its control: the two answers must be the same set. This
 * one cannot go quietly empty the way a closure can — it asks a question about a literal string, and
 * the string is the thing being counted.
 */
export const filesUsingTheRefundWrapper = async (): Promise<string[]> => {
  const files = await typeScriptFilesUnder(SOURCE_ROOT);
  const carrying: string[] = [];

  for (const file of files) {
    const source = await readFile(file, 'utf8');

    // The helper's own definition declares the name; it does not call it.
    if (file.endsWith('hash-refusal-refund.util.ts')) continue;
    if (!source.includes('refundingHashRefusals(')) continue;

    carrying.push(path.relative(path.join(SOURCE_ROOT, '..'), file));
  }

  return carrying;
};
