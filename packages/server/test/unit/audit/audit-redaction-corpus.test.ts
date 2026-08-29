/**
 * @vitest-environment node
 *
 * Every payload this repository actually records, put through the guard that stands in front of the
 * trail (STORY-016-02, acceptance 5).
 *
 * The corpus is read out of the source tree rather than typed out here, and that is the whole point:
 * a list of payloads maintained by hand is a list of the payloads somebody remembered, and the one
 * that leaks is the one added next Tuesday by an author who never read this file. The tree always
 * contains all of them.
 *
 * What it asserts is deliberately narrow and therefore strong: **no call site in the tree names a
 * field the guard would cut**. It is a static read, so what it sees are field names and literal
 * values, not the runtime values behind `input.name` — those are covered by the guard itself
 * (`audit-redaction.test.ts`) and by the adapter test. A name is enough for the failure this catches:
 * `after: { password }` is a leak on the day it is written, and it is written as a name.
 *
 * The controls below are not decoration. A scanner that matched nothing would pass this file in
 * silence, which is the failure mode of every corpus test ever written.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  AUDIT_REDACTED_FIELDS_KEY,
  redactAuditPayload,
} from '@/application/platform/audit/audit-redaction.util.js';

const SRC = fileURLToPath(new URL('../../../src', import.meta.url));

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;

    if (entry.isDirectory()) return sourceFiles(path);

    return entry.name.endsWith('.ts') ? [path] : [];
  });

/** The slice from an opening bracket to the bracket that closes it. */
const balanced = (source: string, open: number, opener: string, closer: string): string => {
  let depth = 0;

  for (let index = open; index < source.length; index += 1) {
    if (source[index] === opener) depth += 1;
    if (source[index] === closer) {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }

  return source.slice(open);
};

interface Payload {
  readonly file: string;
  readonly kind: 'before' | 'after';
  readonly keys: readonly string[];
  readonly literals: readonly string[];
}

/**
 * The `before`/`after` object of every `audit.record(...)` in one file.
 *
 * Keys are taken at every depth — a secret nested one level down is still in the column — in both
 * spellings a call site uses: `reason: input.reason` and the shorthand `{ reason }`. Literal strings
 * are collected too, so a credential pasted into a payload is checked by its shape as well.
 */
const payloadsIn = (file: string, source: string): Payload[] => {
  const found: Payload[] = [];

  for (const match of source.matchAll(/audit\.record\(/g)) {
    const call = balanced(source, match.index + match[0].length - 1, '(', ')');

    for (const field of call.matchAll(/\b(before|after):\s*\{/g)) {
      const object = balanced(call, field.index + field[0].length - 1, '{', '}');
      const keys = new Set<string>();

      for (const [, key] of object.matchAll(/([A-Za-z_$][\w$]*)\s*:/g))
        if (key !== undefined) keys.add(key);
      for (const [, key] of object.matchAll(/[{,]\s*([A-Za-z_$][\w$]*)\s*[,}]/g))
        if (key !== undefined) keys.add(key);

      found.push({
        file,
        kind: field[1] as 'before' | 'after',
        keys: [...keys],
        literals: [...object.matchAll(/'([^'\n]*)'/g)].flatMap(([, value]) =>
          value === undefined ? [] : [value],
        ),
      });
    }
  }

  return found;
};

const corpus = (): Payload[] =>
  sourceFiles(SRC).flatMap((file) =>
    payloadsIn(file.slice(SRC.length + 1), readFileSync(file, 'utf8')),
  );

/**
 * Fields whose **name** reads as key material while the value behind it is a count or a flag.
 *
 * The guard pairs name with type, so at runtime these are kept — a number cannot carry a secret.
 * A static scan cannot see the type, so it would report them forever; this is the register of the
 * ones a person looked at, and it is checked in both directions below: an entry that stops
 * appearing in the tree fails, and a new suspicious name that is not here fails. Adding a line is
 * the point at which somebody has to say out loud that the value is a count.
 */
const NAMED_LIKE_A_SECRET_BUT_COUNTED = new Map<string, string>([
  [
    'recoveryCodesDeleted',
    'how many recovery codes a 2FA reset removed — a number, and the fact the trail is read for',
  ],
]);

/** What the guard would cut out of one harvested payload, as paths. */
const cuts = (payload: Payload): readonly string[] => {
  const probe: Record<string, unknown> = {};

  for (const key of payload.keys)
    if (!NAMED_LIKE_A_SECRET_BUT_COUNTED.has(key)) probe[key] = 'sample';
  for (const [index, literal] of payload.literals.entries())
    probe[`literal_${String(index)}`] = literal;

  const paths = redactAuditPayload(probe)?.[AUDIT_REDACTED_FIELDS_KEY];

  return Array.isArray(paths) ? (paths as readonly string[]) : [];
};

describe('the payloads this tree records', () => {
  const harvested = corpus();

  it('names no field the guard would cut', () => {
    const leaking = harvested.flatMap((payload) => {
      const cut = cuts(payload);

      return cut.length === 0 ? [] : [`${payload.file} (${payload.kind}): ${cut.join(', ')}`];
    });

    expect(leaking).toStrictEqual([]);
  });

  /**
   * CONTROL — the scan reaches the tree.
   *
   * Without this the assertion above is «nothing found in nothing», which is how a corpus test ends
   * up green after a refactor renames the call. The floor is a floor, not a count: it is low enough
   * that ordinary churn never touches it and high enough that an empty scan cannot pass it.
   */
  it('found payloads across many call sites', () => {
    expect(harvested.length).toBeGreaterThanOrEqual(15);
    expect(new Set(harvested.map((payload) => payload.file)).size).toBeGreaterThanOrEqual(10);
  });

  /**
   * CONTROL — the scan reaches the *fields*, not just the calls. Both are shipped today: the full
   * permission set of a role, and the flag that a second factor was on.
   */
  it('found the fields the trail is read for', () => {
    const keys = new Set(harvested.flatMap((payload) => payload.keys));

    expect(keys).toContain('permissions');
    expect(keys).toContain('totpEnabled');
  });

  /**
   * The register above may not rot. An entry nobody records any more is a hole kept open for a
   * field that no longer exists — and the next field with that name would walk straight through it.
   * The third assertion is the one that makes the exemption honest: the field is kept because of
   * its type, and the same name over a string is still cut.
   */
  it.each([...NAMED_LIKE_A_SECRET_BUT_COUNTED.keys()])(
    'still records %s, and keeps it only because it is a number',
    (key) => {
      expect(harvested.flatMap((payload) => payload.keys)).toContain(key);
      expect(redactAuditPayload({ [key]: 3 })).toStrictEqual({ [key]: 3 });
      expect(redactAuditPayload({ [key]: 'a-string-after-all' })).toHaveProperty(
        AUDIT_REDACTED_FIELDS_KEY,
        [key],
      );
    },
  );
});

/**
 * CONTROL — the chain from source text to verdict, end to end, on a call site that leaks.
 *
 * The tree is clean, so nothing above can tell a working scanner from a broken one. These feed the
 * scanner source it has never seen and require it to come back red, which is the only evidence that
 * the green verdict above means anything.
 */
describe('a call site that leaks', () => {
  const leaking = `
    await this.audit.record({
      action: 'user.invited',
      actor: { userId, organizationId, ipAddress: undefined },
      target: { type: 'USER', id: userId },
      after: { email: input.email, password: input.password },
      requestId: undefined,
    });
  `;

  it('is found by the scanner and cut by the guard', () => {
    const [payload] = payloadsIn('leaking.use-case.ts', leaking);

    expect(payload?.keys).toContain('password');
    expect(cuts(payload!)).toStrictEqual(['password']);
  });

  it('is found when the secret is nested and written shorthand', () => {
    const [payload] = payloadsIn(
      'leaking.use-case.ts',
      `await this.audit.record({ after: { provider: { apiKey } } });`,
    );

    expect(cuts(payload!)).toStrictEqual(['apiKey']);
  });

  it('is found when a credential is pasted in as a literal under an innocent name', () => {
    const [payload] = payloadsIn(
      'leaking.use-case.ts',
      `await this.audit.record({ after: { link: 'https://s3.local/f?X-Amz-Signature=abc' } });`,
    );

    expect(cuts(payload!)).toStrictEqual(['literal_0']);
  });
});

/**
 * The guard sits in one place, and this is what keeps it there.
 *
 * `PrismaAuditLogger` redacts and then either writes the row or hands the event to its `unscoped`
 * sink, so both channels are covered by one call — but only for as long as the pino adapter is
 * reached *through* it. Composed as an `AuditLoggerPort` in its own right, it would be a second door
 * into the trail with no guard on it, and nothing else in the repository would notice.
 *
 * Decorators between the slot and the adapter are allowed, and the pattern says so: the sink is
 * wrapped in `countedUnscopedAuditLogger` to give the log path a number. What the pattern still
 * refuses is the thing that matters — `pinoAuditLogger(...)` reachable anywhere other than from the
 * `unscoped:` slot, decorated or not.
 */
/** A line that reaches the log sink from somewhere other than the guarded `unscoped:` slot. */
const escapesTheGuard = (line: string): boolean =>
  line.includes('pinoAuditLogger(') &&
  !/unscoped:\s*(?:[A-Za-z_$][\w$]*\()*pinoAuditLogger\(/.test(line);

describe('the way into the trail', () => {
  it('composes the log sink only as the unscoped half of the row writer', () => {
    const composed = sourceFiles(SRC)
      .filter((file) => !file.endsWith('pino-audit.adapter.ts'))
      .flatMap((file) =>
        readFileSync(file, 'utf8')
          .split('\n')
          .flatMap((line) =>
            escapesTheGuard(line) ? [`${file.slice(SRC.length + 1)}: ${line.trim()}`] : [],
          ),
      );

    expect(composed).toStrictEqual([]);
  });

  /**
   * CONTROL for the pattern itself. It was widened to let a decorator sit between the slot and the
   * adapter; a pattern widened once is a pattern that can be widened into uselessness, and a scan
   * over a clean tree passes either way. These two lines say what it still refuses.
   */
  it.each([
    'const audit = pinoAuditLogger(logger, clock);',
    'return { audit: pinoAuditLogger(logger, clock) };',
    'unscopedish: pinoAuditLogger(logger, clock),',
  ])('CONTROL: still refuses `%s`', (line) => {
    expect(escapesTheGuard(line)).toBe(true);
  });

  it.each([
    '      unscoped: pinoAuditLogger(logger, clock),',
    '      unscoped: countedUnscopedAuditLogger(pinoAuditLogger(logger, clock), metrics),',
  ])('CONTROL: allows `%s`', (line) => {
    expect(escapesTheGuard(line)).toBe(false);
  });
});
