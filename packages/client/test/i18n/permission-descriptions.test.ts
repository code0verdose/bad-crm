/**
 * @vitest-environment node
 *
 * Which keys of the permission catalogue owe a sentence, and which are openly excused.
 *
 * `PERMISSION_META` carries a `descriptionKey` for every key of the closed catalogue, and the rights
 * screen of a personnel card renders it. The catalogue, however, describes the whole product —
 * tasks, documents, vault, time, channels — while the product itself answers twenty-odd endpoints.
 * Writing three hundred sentences for features that do not exist is the very mistake STORY-011-01
 * deferred against («писать 662 строки за месяцы до экрана, который их выведет, значит переписывать
 * их дважды»), so the deferral is kept — but as a **statement with a reason**, the way
 * `catalogue-parity.test.ts` keeps `AWAITING_A_SENTENCE`, rather than as silence.
 *
 * The rule that decides the scope is mechanical and not a matter of taste: **a key is shipped when
 * some route declares it.** Both places that declare one are read — `x-permission` in
 * `docs/api/openapi.yaml` (the contract, ADR-0003) and the route registry the server actually mounts
 * — because a key present in only one of them is a defect somewhere else, and this gate should
 * demand a sentence for it either way.
 *
 * Two directions are asserted, and the second is what keeps the registry from rotting:
 *
 *   * every shipped key has an English and a Russian sentence — a key that acquires a route
 *     acquires a description in the same delta or fails here;
 *   * nothing else has one. A description written ahead of the route it belongs to fails too,
 *     which is what makes «described» and «shipped» the same set rather than two lists to keep in
 *     step by hand.
 *
 * The registry below is per **resource** rather than per key: a reason is a property of the feature
 * («there are no tasks in this product yet»), and 308 copies of one sentence would be a list nobody
 * reads. It cannot outlive its reason either — a resource whose keys have all been shipped has no
 * line left to stand on, and the last case fails on it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { SharedPermissions } from '@bad-crm/shared';
import { describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
const LOCALES = `${REPO}/packages/client/src/shared/i18n/locales`;
const OPENAPI = `${REPO}/docs/api/openapi.yaml`;
const ROUTE_REGISTRY = `${REPO}/packages/server/src/presentation/http/route-registry.factory.ts`;

/**
 * The resources whose keys are deliberately left without a sentence, with the reason each is.
 *
 * A line here excuses only the keys of that resource **which no route declares**; the moment one of
 * them is mounted, the assertion above stops being satisfied by this file and the sentence has to be
 * written. A resource fully shipped keeps no line at all — `team`, `invitation` and `role` are
 * absent below for exactly that reason, and were absent from the product a milestone ago.
 */
const AWAITING_A_ROUTE: Readonly<Record<string, string>> = {
  organization: 'the settings screens of the organization are not built (M2 tail)',
  mail: 'corporate mail is EPIC-049, reconsidered at its own milestone kickoff',
  user: 'the account actions left — delete, impersonate, sessions — have no screen yet',
  employee: 'employment, cost rate and personal data are the paid half of the card (M3)',
  permission: 'the catalogue itself and `explain` need the resource layer (STORY-011-06)',
  acl: 'blocked with STORY-011-06: no domain owns a resource to hang an ACL on',
  project:
    'EPIC-014 in progress: `project:read` is routed and described; the eleven keys of the write ' +
    'side wait for their routes (create, update, members, visibility, archive, budget)',
  board: 'boards arrive with tasks (M3)',
  task: 'tasks are M3 — the largest domain of the catalogue and none of it exists',
  sprint: 'sprints arrive with tasks (M3)',
  comment: 'comments have no host entity until tasks and documents exist (M3)',
  doc: 'documents are M3',
  kb_space: 'the knowledge base is M3',
  kb_note: 'the knowledge base is M3',
  file: 'files are EPIC-015, no storage adapter is wired yet',
  vault: 'the E2EE vault is M4 (EPIC-048); its wording waits for its crypto review',
  vault_item: 'the E2EE vault is M4 (EPIC-048); its wording waits for its crypto review',
  secure_link: 'secure links ship with the vault (M4)',
  time: 'time tracking is M3',
  timesheet: 'timesheets ship with time tracking (M3)',
  channel: 'chat is M4',
  message: 'chat is M4',
  dashboard: 'dashboards need something to count first (M5)',
  report: 'reports need something to count first (M5)',
  integration: 'integrations are M6',
  repo_link: 'the GitHub integration is M6',
  ci: 'the GitHub integration is M6',
  deployment: 'the GitHub integration is M6',
  webhook: 'the GitHub integration is M6',
  ai: 'the assistant is M4+ and has no context in the code at all',
  delivery: 'project leadership is M7',
  client: 'project leadership is M7',
  contract: 'project leadership is M7',
  invoice: 'project leadership is M7',
  payment: 'project leadership is M7',
  milestone: 'project leadership is M7',
  call: 'project leadership is M7',
  action_item: 'project leadership is M7',
  risk: 'project leadership is M7',
  stakeholder: 'project leadership is M7',
  audit: 'reading the audit log is the open half of EPIC-016',
  settings: 'the platform settings screens are M8',
  api_token: 'the platform settings screens are M8',
  mcp: 'the MCP adapter is EPIC-048, reconsidered at its own milestone kickoff',
  notification: 'notifications are M8',
  onboarding: 'onboarding is M8',
  material: 'onboarding materials are M8',
  search: 'search is M5',
  job: 'there is no scheduler in the product — see STORY-011-01, «чего нет и почему»',
};

/** `x-permission: role:assign` — the contract's own word on what gates an operation. */
const declaredByContract = (): Set<string> =>
  new Set(
    [...readFileSync(OPENAPI, 'utf8').matchAll(/^\s*x-permission:\s*([a-z_]+:[a-z_]+)\s*$/gm)].map(
      ([, key]) => key ?? '',
    ),
  );

/** `permission: 'role:assign'` — what the process mounts, which is the half that actually refuses. */
const declaredByRoutes = (): Set<string> =>
  new Set(
    [...readFileSync(ROUTE_REGISTRY, 'utf8').matchAll(/permission: '([a-z_]+:[a-z_]+)'/g)].map(
      ([, key]) => key ?? '',
    ),
  );

const shippedKeys = (): Set<string> => new Set([...declaredByContract(), ...declaredByRoutes()]);

/** `permission.role.assign`, … — every key the `permission` namespace of a language answers. */
const describedKeys = (language: string): Set<string> => {
  const tree: unknown = JSON.parse(
    readFileSync(`${LOCALES}/${language}/permission.json`, 'utf8'),
  ) as unknown;

  const flatten = (value: unknown, prefix: string): string[] => {
    if (typeof value === 'string') return [prefix];
    if (typeof value !== 'object' || value === null) return [];

    return Object.entries(value).flatMap(([key, nested]) => flatten(nested, `${prefix}.${key}`));
  };

  return new Set(flatten(tree, 'permission'));
};

const descriptionKeyOf = (key: string): string =>
  SharedPermissions.PERMISSION_META[key as SharedPermissions.PermissionKey].descriptionKey;

const resourceOf = (key: string): string => key.split(':')[0] ?? '';

describe('the descriptions of the permission catalogue', () => {
  it('CONTROL: reads a catalogue, two route declarations and two locales', () => {
    // Every assertion below is vacuously true on an empty set — a renamed file, a changed shape of
    // the registry, a locale directory moved — so each source is shown to have been found.
    expect(SharedPermissions.PERMISSIONS.length).toBeGreaterThan(300);
    expect(declaredByContract().size).toBeGreaterThan(10);
    expect(declaredByRoutes().size).toBeGreaterThan(10);
    expect(describedKeys('en').size).toBeGreaterThan(10);
    expect(describedKeys('ru').size).toBeGreaterThan(10);
    // And the deferral is a real one: most of the catalogue is still excused.
    expect(shippedKeys().size).toBeLessThan(SharedPermissions.PERMISSIONS.length);
  });

  it.each(['en', 'ru'])('describes every key a route declares — %s', (language) => {
    const described = describedKeys(language);
    const missing = [...shippedKeys()]
      .filter((key) => !described.has(descriptionKeyOf(key)))
      .sort();

    expect(
      missing,
      `these permissions gate an endpoint and have no ${language} sentence — the screen would ` +
        'show the raw key and nothing else',
    ).toEqual([]);
  });

  it.each(['en', 'ru'])('describes nothing a route does not declare — %s', (language) => {
    const shipped = new Set([...shippedKeys()].map(descriptionKeyOf));

    // The other direction, and it is the deferral being enforced rather than merely stated: a
    // sentence written for a feature that does not exist is a sentence rewritten when it does.
    expect([...describedKeys(language)].filter((key) => !shipped.has(key)).sort()).toEqual([]);
  });

  it('leaves no key both undescribed and unexcused', () => {
    const shipped = shippedKeys();
    const unexcused = SharedPermissions.PERMISSIONS.filter(
      (key) => !shipped.has(key) && !(resourceOf(key) in AWAITING_A_ROUTE),
    );

    expect(
      unexcused,
      'a new resource in the catalogue owes either a sentence or a line in AWAITING_A_ROUTE',
    ).toEqual([]);
  });

  it('keeps no line in the awaiting-a-route registry that is no longer true', () => {
    const shipped = shippedKeys();
    const stillWaiting = new Set(
      SharedPermissions.PERMISSIONS.filter((key) => !shipped.has(key)).map(resourceOf),
    );

    // A resource whose every key now has a route is excused for nothing — the line has to go, and
    // its keys have to be described. This is the half that makes the registry an assertion.
    expect(Object.keys(AWAITING_A_ROUTE).filter((resource) => !stillWaiting.has(resource))).toEqual(
      [],
    );
  });

  it('says something the key does not already say, in both languages', () => {
    const failures = [...shippedKeys()].flatMap((key) =>
      ['en', 'ru'].flatMap((language) => {
        const tree: unknown = JSON.parse(
          readFileSync(`${LOCALES}/${language}/permission.json`, 'utf8'),
        ) as unknown;
        const [, resource, action] = descriptionKeyOf(key).split('.');
        const sentence = ((tree as Record<string, Record<string, string>>)[resource ?? ''] ?? {})[
          action ?? ''
        ];

        // A description that restates the key («suspend user») costs a translation and tells an
        // administrator nothing they could not read off the row header two centimetres to the left.
        return sentence !== undefined && sentence.length > 30 ? [] : [`${key} (${language})`];
      }),
    );

    expect(failures).toEqual([]);
  });
});
