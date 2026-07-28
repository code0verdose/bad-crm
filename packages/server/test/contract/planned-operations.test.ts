import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { collectRoutes, routeKey } from './collect-routes.util.js';
import {
  PLANNED_MARKER,
  plannedStory,
  readOpenApiDocument,
  specOperationEntries,
  type SpecOperation,
} from './openapi-document.util.js';
import { createTestApp } from '../support/test-app.util.js';

/**
 * The rules around `x-implemented-by`, which is the one thing in this repository that lets a
 * published operation exist without a route behind it.
 *
 * Contract-first puts the specification in the same pull request as the discussion of the API and
 * *before* the implementation (ADR-0003, `docs/api/README.md`). The second direction of
 * `openapi.test.ts` — every published operation has a route — is what makes a client able to trust
 * the document, and it is also, briefly, in the way of that order. The choice is between weakening
 * the assertion for everything and marking the handful of operations it does not hold for yet.
 *
 * This suite is the price of the second option, and it is deliberately steeper than the exemption
 * is worth abusing for:
 *
 * 1. the marker names a story, and the story file has to exist — a marker cannot say "later";
 * 2. a marked operation must **not** be served — the moment the route appears, this fails and says
 *    to delete the marker, so an exemption cannot outlive the reason for it;
 * 3. the marked set is printed on failure, so "what is still owed" is one test run away.
 *
 * What it deliberately does not do is bound the exemption by time or by count. A marker that names
 * a real, open story is a promise somebody can check against the board; a deadline in a test file
 * is a date that gets bumped.
 */

const EPICS_ROOT = fileURLToPath(new URL('../../../../epics', import.meta.url));

const STORY_ID = /^STORY-\d{3}-\d{2}$/;

/**
 * The statuses a story may hold while an operation is still waiting for it.
 *
 * `review` and `done` are absent on purpose: both mean the work is finished and the commit gate is
 * green (`rules/epic-driven-development.mdc`), so an operation still exempt from "every published
 * operation has a route" is either owned by nobody or was implemented and never unmarked. Without
 * this, `x-implemented-by: STORY-001-01` — a story closed weeks ago, in an epic that has nothing to
 * do with this operation — satisfies every other assertion here, and the exemption becomes
 * permanent.
 */
const OPEN_STATUSES = new Set(['backlog', 'ready', 'in-progress']);

interface StoryLocation {
  /** Directory of the epic the file was found in — `epic-006-auth-core`. */
  readonly epic: string;
  readonly file: string;
}

/** Every story file in the repository, with the epic directory it belongs to. */
const storyFiles = (): StoryLocation[] =>
  readdirSync(EPICS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((epic) => {
      const stories = `${EPICS_ROOT}/${epic.name}/stories`;

      try {
        return readdirSync(stories)
          .filter((file) => file.endsWith('.md'))
          .map((file) => ({ epic: epic.name, file }));
      } catch {
        // An epic without a `stories` directory is an epic whose stories are not written yet
        // (M3–M9, CLAUDE.md). It contributes no story files and is not an error.
        return [];
      }
    });

interface StoryFacts {
  /** The epic number in the directory name — `epic-006-auth-core` → `006`. */
  readonly epic: string;
  readonly status: string;
}

/**
 * What the board knows about the story a marker names: which epic holds it and what state it is in.
 *
 * Read from the frontmatter rather than from the file name, because the file name is the half a
 * marker can satisfy by accident and the status is the half that expires.
 */
const readStory = (id: string): StoryFacts | undefined => {
  const found = storyFiles().find((entry) => entry.file.startsWith(`${id.toLowerCase()}-`));

  if (found === undefined) return undefined;

  const source = readFileSync(`${EPICS_ROOT}/${found.epic}/stories/${found.file}`, 'utf8');
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1] ?? '';

  return {
    epic: /^epic-(\d{3})-/.exec(found.epic)?.[1] ?? '',
    status: /^status:\s*(\S+)\s*$/m.exec(frontmatter)?.[1] ?? '',
  };
};

const storyExists = (id: string): boolean => readStory(id) !== undefined;

/** `STORY-006-04` → `006`, the epic the id claims to belong to. */
const epicOf = (id: string): string => id.slice('STORY-'.length, 'STORY-'.length + 3);

const plannedOperations = (): SpecOperation[] =>
  specOperationEntries(readOpenApiDocument()).filter(
    (entry) => plannedStory(entry.operation) !== undefined,
  );

const servedRouteKeys = (): Set<string> =>
  new Set(collectRoutes(createTestApp().app).map(routeKey));

describe('an operation published ahead of its implementation', () => {
  it('names the story that implements it, in a form the board uses', () => {
    const malformed = plannedOperations()
      .map((entry) => ({ route: entry.routeKey, story: plannedStory(entry.operation) ?? '' }))
      .filter((entry) => !STORY_ID.test(entry.story));

    expect(malformed, `${PLANNED_MARKER} must be a story id such as STORY-006-02`).toEqual([]);
  });

  it('names a story that exists', () => {
    const dangling = plannedOperations()
      .map((entry) => ({ route: entry.routeKey, story: plannedStory(entry.operation) ?? '' }))
      .filter((entry) => !storyExists(entry.story));

    expect(
      dangling,
      'the story named by x-implemented-by has no file under epics/*/stories — the marker points at nothing and the operation has no owner',
    ).toEqual([]);
  });

  /**
   * The half a file name cannot express. A marker may name **any** story in the repository, and
   * "exists" is satisfied by every one of the 113 — including the closed ones. A story in `review`
   * or `done` has passed the commit gate; an operation it supposedly implements and that is still
   * unserved is either owed by nobody or was implemented and left marked, and in both cases the
   * exemption from "every published operation has a route" is now permanent.
   */
  it('names a story that is still open', () => {
    const closed = plannedOperations()
      .map((entry) => ({
        route: entry.routeKey,
        story: plannedStory(entry.operation) ?? '',
      }))
      .map((entry) => ({ ...entry, status: readStory(entry.story)?.status ?? 'unknown' }))
      .filter((entry) => !OPEN_STATUSES.has(entry.status));

    expect(
      closed,
      `${PLANNED_MARKER} names a story that is not open: a story in review or done cannot still owe an implementation`,
    ).toEqual([]);
  });

  /**
   * And that the story is the one its own id points at. `STORY-006-04` has to live under
   * `epics/epic-006-…`; a file that says otherwise is either misfiled or a marker that borrowed an
   * id from another epic, and the board would then show work under an epic that is not doing it.
   */
  it('names a story filed under the epic its id names', () => {
    const misfiled = plannedOperations()
      .map((entry) => ({ route: entry.routeKey, story: plannedStory(entry.operation) ?? '' }))
      .map((entry) => ({ ...entry, epic: readStory(entry.story)?.epic ?? 'unknown' }))
      .filter((entry) => entry.epic !== epicOf(entry.story));

    expect(misfiled, `${PLANNED_MARKER} names a story that lives in another epic`).toEqual([]);
  });

  /**
   * The removal trigger, and the reason this mechanism is not a way to publish fiction: once the
   * route answers, the exemption has nothing left to stand on and this test says so by name.
   */
  it('is not served yet, or the marker has to go', () => {
    const served = servedRouteKeys();
    const stale = plannedOperations()
      .map((entry) => entry.routeKey)
      .filter((key) => served.has(key));

    expect(
      stale,
      `implemented while still marked ${PLANNED_MARKER}: ${stale.join(', ')} — delete the marker from docs/api/openapi.yaml, the operation is real now`,
    ).toEqual([]);
  });

  it('is the only reason the specification may run ahead of the router', () => {
    const documented = specOperationEntries(readOpenApiDocument());
    const served = servedRouteKeys();
    const unexplained = documented
      .filter((entry) => !served.has(entry.routeKey))
      .filter((entry) => plannedStory(entry.operation) === undefined)
      .map((entry) => entry.routeKey);

    expect(
      unexplained,
      `published, unimplemented and unexplained: ${unexplained.join(', ')}`,
    ).toEqual([]);
  });

  /**
   * The state of the epic, made visible: the list is expected to shrink to nothing, and this is how
   * a reader sees where it stands without opening the specification.
   *
   * Written as "the offenders are none" rather than as `outstanding.every(…)`, which was a
   * predicate over a list that will one day be empty — and `[].every` is `true`, so the day the
   * marked set emptied this assertion would have started passing for the wrong reason while still
   * looking like it checked the format of something.
   */
  it('is listed with its story, so the outstanding work is visible', () => {
    const malformed = plannedOperations()
      .map((entry) => `${entry.routeKey} → ${plannedStory(entry.operation) ?? ''}`)
      .filter((line) => !/ → STORY-\d{3}-\d{2}$/.test(line));

    expect(malformed).toEqual([]);
  });
});

/**
 * The helpers the suite above leans on, checked against the cases they must not get wrong.
 *
 * Every assertion up there has the shape "the offending list is empty", which is also what a broken
 * lookup returns: `readStory` answering `undefined` for everything would make the status and epic
 * checks report `'unknown'`… and those *are* refused, so that direction fails loudly. The direction
 * that fails quietly is the opposite one — a lookup that never refuses anything — and this is what
 * rules it out.
 */
describe('the story lookup', () => {
  it('finds a story that exists and misses one that does not', () => {
    expect(storyExists('STORY-006-01')).toBe(true);
    expect(storyExists('STORY-999-99')).toBe(false);
  });

  it('reads the epic and the status out of the file, not out of the id', () => {
    expect(readStory('STORY-006-04')).toEqual({ epic: '006', status: 'backlog' });
  });

  /**
   * The exact marker the review called out: a real story, in a real epic, closed long ago.
   * `storyExists` says yes; the status check is what says no.
   */
  it('reports a closed story as closed, so a marker cannot borrow one', () => {
    const closed = readStory('STORY-001-01');

    expect(closed?.status).toBe('done');
    expect(OPEN_STATUSES.has(closed?.status ?? '')).toBe(false);
  });

  it('derives the epic a story id claims', () => {
    expect(epicOf('STORY-006-04')).toBe('006');
    expect(epicOf('STORY-001-01')).toBe('001');
  });
});
