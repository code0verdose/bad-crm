import { SharedPermissions } from '@bad-crm/shared';

/**
 * The four verdicts `evaluateMfaRequirement` gives, as the screen's own closed set.
 *
 * Declared here rather than imported from `api`, because `model` may not import `api`
 * (`test/architecture/layers.test.ts`) — and the direction is right: a filter and a label map are
 * about the domain, not about the wire. That the two agree is not left to hope:
 * `organization.api.ts` carries a type-level assertion that fails to compile the day the contract
 * grows a fifth verdict.
 */
export const MFA_GATES = ['not_covered', 'satisfied', 'grace', 'enrollment_required'] as const;

export type MfaGate = (typeof MFA_GATES)[number];

/**
 * The verdict of one person, as a sentence.
 *
 * **Written out rather than composed.** `organization.security.gate.${gate}` is one line and it is
 * the line ADR-0019 forbids: a key assembled at runtime is a key no gate can see, so a catalogue
 * missing all four would pass `catalogue-parity.test.ts` and render `organization.security.gate.grace`
 * at an administrator. `Record<MfaGate, string>` also makes a fifth verdict on the server a compile
 * error here, before it can be an untranslated word on the screen.
 */
export const MFA_GATE_LABEL: Readonly<Record<MfaGate, string>> = {
  not_covered: 'organization.security.gate.notCovered',
  satisfied: 'organization.security.gate.satisfied',
  grace: 'organization.security.gate.grace',
  enrollment_required: 'organization.security.gate.enrollmentRequired',
};

/**
 * The colour each verdict is drawn in — the semantic tokens, never a literal
 * (`rules/design-system.mdc`).
 *
 * `enrollment_required` is `danger` because it is the only one that already costs somebody their
 * access; `grace` is `warning` because it will; «not covered» is neutral, and rendering it in green
 * beside «satisfied» would say the policy protects somebody it says nothing about.
 */
export const MFA_GATE_COLOR: Readonly<Record<MfaGate, string>> = {
  not_covered: 'gray',
  satisfied: 'success',
  grace: 'warning',
  enrollment_required: 'danger',
};

/**
 * The roles the policy may be built from on this screen, and what each is called.
 *
 * The seven system keys, from the closed catalogue in `@bad-crm/shared` — so the picker cannot offer
 * a role the server would refuse, and no second request is needed to draw it.
 *
 * **Custom roles are supported by the contract and are not offered here.** A `PolicyRoleRef` may be
 * the uuid of a custom role, and a policy that already names one keeps it: the editor sends back
 * every reference it was given. What is missing is the picker for them, which needs `GET /roles` and
 * therefore `role:read` — a second permission on a screen gated by `organization:manage_security_policy`.
 * It is recorded as open in STORY-013-05 rather than half-built here.
 */
export const POLICY_ROLE_KEYS = SharedPermissions.SYSTEM_ROLE_KEYS;

export const POLICY_ROLE_LABEL: Readonly<Record<SharedPermissions.SystemRoleKey, string>> = {
  owner: 'organization.security.role.owner',
  admin: 'organization.security.role.admin',
  manager: 'organization.security.role.manager',
  lead: 'organization.security.role.lead',
  developer: 'organization.security.role.developer',
  viewer: 'organization.security.role.viewer',
  guest: 'organization.security.role.guest',
};
