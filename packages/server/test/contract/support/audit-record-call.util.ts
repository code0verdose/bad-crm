/**
 * Parses `audit.record({ ... })` call sites out of source text, without executing it.
 *
 * The gate this feeds (`audit-privileged-ip-address.test.ts`) has to answer «does this privileged,
 * human-triggered call site carry an address» from what is actually written in
 * `packages/server/src/application/**`, not from a list of action names copied into the test by
 * hand — a list like that is exactly what CLAUDE.md's «доказательство красного» warns against:
 * it stops tracking the code the moment the code changes under it. Everything here works off the
 * literal text of the call block: which action string appears, whether `actor.userId` is the literal
 * `undefined` (a system-origin event, see `AuditActor`'s own docstring) or a real expression, whether
 * `actor.ipAddress` is the literal `undefined`, what `target.type` reads, and whether the block
 * carries a `before` key without an `after` one (something that existed and now does not — the shape
 * every revocation/deletion entry in this codebase has, and the one creation/self-service entries
 * lack).
 */

export interface AuditRecordCallSite {
  readonly filePath: string;
  readonly line: number;
  /** The action literal(s) this call site can produce — more than one only for a ternary action. */
  readonly actions: readonly string[];
  /** `false` when `actor.userId` is the literal `undefined` — a system/background-origin event. */
  readonly humanOrigin: boolean;
  /** `false` when `actor.ipAddress` is the literal `undefined`. */
  readonly hasIpAddress: boolean;
  /** `target.type`, read verbatim from the block — `null` if it could not be found. */
  readonly targetType: string | null;
  /** The source text of `target.id`'s value — `null` if absent (a capability-only event). */
  readonly targetIdExpr: string | null;
  /** The source text of `actor.userId`'s value. */
  readonly actorUserIdExpr: string | null;
  /** Whether the payload section (after `target`) contains a `before:` key. */
  readonly hasBefore: boolean;
  /** Whether the payload section (after `target`) contains an `after:` key. */
  readonly hasAfter: boolean;
  /**
   * `false` when `actor` or `target` was not written as an object literal here — the shorthand
   * `actor,`/`target,` form, which has no `type` and no `ipAddress` to read. Such a site is reported
   * rather than dropped: what an unjudgeable site is allowed to be is the gate's decision, not this
   * parser's. Every other field of an unresolved site is the conservative reading — human origin,
   * no address, unknown target.
   */
  readonly resolved: boolean;
}

const CALL_PATTERN = /\baudit\.record\(\{/g;
const ACTION_LITERAL_PATTERN = /'([a-z][a-z_]*(?:\.[a-z_]+)+)'/g;

/**
 * Walks from `openBraceIndex` (which must point at `{`) to the matching `}`, skipping over the
 * contents of string literals so a brace inside a quoted message cannot desynchronise the count.
 * Returns the index just past the matching `}`, or `null` if the source ends unbalanced.
 */
const findMatchingBrace = (source: string, openBraceIndex: number): number | null => {
  let depth = 0;
  let inString: '"' | "'" | '`' | null = null;

  for (let i = openBraceIndex; i < source.length; i += 1) {
    const ch = source[i];

    if (inString !== null) {
      if (ch === '\\') {
        i += 1;
      } else if (ch === inString) {
        inString = null;
      }

      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      continue;
    }

    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;

      if (depth === 0) return i + 1;
    }
  }

  return null;
};

/** The value text following `key:` up to the next top-level comma or the section's end. */
const readKeyValue = (section: string, key: string): string | null => {
  const match = new RegExp(`\\b${key}:\\s*`).exec(section);

  if (match === null) return null;

  let depth = 0;
  let inString: '"' | "'" | '`' | null = null;
  const start = match.index + match[0].length;

  for (let i = start; i < section.length; i += 1) {
    const ch = section[i];

    if (inString !== null) {
      if (ch === '\\') {
        i += 1;
      } else if (ch === inString) {
        inString = null;
      }

      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      continue;
    }

    if (ch === '{' || ch === '(' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ')' || ch === ']') {
      if (depth === 0) return section.slice(start, i).trim();
      depth -= 1;
    } else if (ch === ',' && depth === 0) {
      return section.slice(start, i).trim();
    }
  }

  return section.slice(start).trim();
};

/**
 * The span of one object-valued key (`actor: { … }`) inside a call block, located wherever it sits.
 *
 * Deliberately independent of the other keys' positions: object keys have no order in TypeScript,
 * and a parser that assumed one (`actor` before `target`) let a pure reformat carry a call site out
 * of the gate's scope along with its missing address.
 */
const objectSectionSpan = (
  block: string,
  key: 'actor' | 'target',
): { readonly start: number; readonly end: number } | null => {
  const match = new RegExp(`\\b${key}:\\s*\\{`).exec(block);

  if (match === null) return null;

  const openBraceIndex = match.index + match[0].length - 1;
  const closeIndex = findMatchingBrace(block, openBraceIndex);

  return closeIndex === null ? null : { start: match.index, end: closeIndex };
};

/** Finds every `audit.record({ ... })` call site in one file's source text. */
export const findAuditRecordCalls = (
  filePath: string,
  source: string,
): readonly AuditRecordCallSite[] => {
  const sites: AuditRecordCallSite[] = [];

  for (const match of source.matchAll(CALL_PATTERN)) {
    const openBraceIndex = match.index + match[0].length - 1;
    const closeIndex = findMatchingBrace(source, openBraceIndex);

    if (closeIndex === null) continue;

    const block = source.slice(openBraceIndex, closeIndex);

    const actorSpan = objectSectionSpan(block, 'actor');
    const targetSpan = objectSectionSpan(block, 'target');
    const resolved = actorSpan !== null && targetSpan !== null;

    const actorSection = actorSpan === null ? '' : block.slice(actorSpan.start, actorSpan.end);
    const targetSection = targetSpan === null ? '' : block.slice(targetSpan.start, targetSpan.end);

    // The payload is what is left once both object sections are cut out — computed by removal
    // rather than as «everything after `target`», so `before`/`after` are found whichever side of
    // the payload the two sections happen to be written on.
    const payloadSection = [actorSpan, targetSpan]
      .filter((span): span is { start: number; end: number } => span !== null)
      .sort((a, b) => b.start - a.start)
      .reduce((text, span) => text.slice(0, span.start) + text.slice(span.end), block);

    const actorUserIdExpr = resolved ? readKeyValue(actorSection, 'userId') : null;
    const actorIpExpr = resolved ? readKeyValue(actorSection, 'ipAddress') : null;
    const targetTypeExpr = resolved ? readKeyValue(targetSection, 'type') : null;
    const targetIdExpr = resolved ? readKeyValue(targetSection, 'id') : null;

    const actions = [
      ...new Set(
        [...block.matchAll(ACTION_LITERAL_PATTERN)]
          .map((m) => m[1])
          .filter((value): value is string => value !== undefined),
      ),
    ];
    const line = source.slice(0, match.index).split('\n').length;

    sites.push({
      filePath,
      line,
      actions,
      humanOrigin: actorUserIdExpr !== 'undefined',
      hasIpAddress: resolved && actorIpExpr !== 'undefined',
      targetType: targetTypeExpr === null ? null : targetTypeExpr.replace(/^'|'$/g, ''),
      targetIdExpr,
      actorUserIdExpr,
      hasBefore: /\bbefore:/.test(payloadSection),
      hasAfter: /\bafter:/.test(payloadSection),
      resolved,
    });
  }

  return sites;
};

/**
 * The target types whose change moves somebody's authority.
 *
 * `TEAM` and `RESOURCE_ACL` joined on 2026-09-26, when `POST /acl` began to accept a team: a grant
 * on an object is authority by definition, and a team membership now carries every grant the team
 * holds. Without `TEAM` here the only membership entry the gate would judge is the revocation-shaped
 * `team.member_removed`; `team.member_added` — the one that *gives* access — would go unchecked.
 * A team's own `INFO` entries (`team.created`, `team.updated`) are untouched: this set is read only
 * at `WARNING`.
 */
const AUTHORITY_TARGET_TYPES: ReadonlySet<string> = new Set([
  'ROLE',
  'USER_ROLE',
  'USER_PERMISSION_OVERRIDE',
  'ORGANIZATION',
  'TEAM',
  'RESOURCE_ACL',
]);

/**
 * Whether a call site is privileged enough that a human-triggered instance of it must carry an
 * address — derived from the parsed call site plus the action's severity, never from a name typed
 * into this file.
 *
 * `CRITICAL` is always required — the top of the three levels this codebase's own comments say an
 * installation "should alert on" (`organization.ownership_transferred`, `role.dangerous_granted`,
 * `rls.bypassed`, `session.refresh_reuse_detected`, `user.mfa_reset_by_admin`, already fixed).
 *
 * Below `CRITICAL`, three structural reasons apply — **at `WARNING` only**, with one exception
 * (`invitation.revoked`) carved out explicitly below rather than left to accidentally match:
 *
 * 1. **`target.type` names an organization-authority object** — `ROLE`, `USER_ROLE`,
 *    `USER_PERMISSION_OVERRIDE` or `ORGANIZATION`. Nothing self-service ever addresses one of these:
 *    they exist only for role composition, role assignment, permission overrides and the tenant root.
 * 2. **`target.type === 'USER'`, the target is not the actor's own account, and the entry records an
 *    actual change** (`before` or `after` present — otherwise it is a read, like
 *    `permission.inspected`, which happens to also address a `USER` and also happens to be about
 *    somebody else). "Not the actor's own account" is read structurally, by comparing the source text
 *    of `target.id` against `actor.userId`: identical text is the actor acting on themselves (a
 *    password change, an abandoned 2FA draft) and is left alone on purpose; different text is an
 *    administrator acting on somebody else — offboarding, reactivation.
 * 3. **The payload has a `before` and no `after`.** That shape is what every entry which took
 *    something away writes (a role deleted, an override removed, a team disbanded) and is absent from
 *    every entry that only adds something (a role created, an invitation sent or accepted).
 *
 * **`invitation.revoked` is `INFO`** — the one action in the catalogue whose own severity disagrees
 * with the judgement this gate encodes, on the grounds `docs/security/permission-model.md` gives an
 * `INFO` row: revoking takes access away before it was ever exercised, but STORY-012-01's own trail
 * design still treats it as the twin of `role.revoked`. Rather than let it slip through the
 * `severity !== 'WARNING'` filter silently (which would also silently swallow the next `INFO` action
 * that happens to share `target.type === 'INVITATION'` and a before-without-after shape, with no test
 * telling anyone), the one exception is named here as what it structurally is: an `INFO` action
 * targeting `INVITATION` with a `before` and no `after` is required too, and nothing else at `INFO`
 * is.
 */
export const requiresAddressWhenHuman = (
  site: Pick<
    AuditRecordCallSite,
    'targetType' | 'targetIdExpr' | 'actorUserIdExpr' | 'hasBefore' | 'hasAfter'
  >,
  severity: 'INFO' | 'WARNING' | 'CRITICAL',
): boolean => {
  if (severity === 'CRITICAL') return true;

  const revocationShaped = site.hasBefore && !site.hasAfter;

  if (severity === 'INFO') {
    // The one named exception — see the docstring above. Every other INFO action (a read, a
    // membership change, a rename) is left alone regardless of target type or before/after shape.
    return site.targetType === 'INVITATION' && revocationShaped;
  }

  // severity === 'WARNING' from here on.
  if (site.targetType !== null && AUTHORITY_TARGET_TYPES.has(site.targetType)) return true;

  if (
    site.targetType === 'USER' &&
    site.targetIdExpr !== null &&
    site.actorUserIdExpr !== null &&
    site.targetIdExpr !== site.actorUserIdExpr &&
    (site.hasBefore || site.hasAfter)
  ) {
    return true;
  }

  return revocationShaped;
};
