/**
 * Where a session the organization's second-factor policy has scoped to enrolment is sent.
 *
 * A constant rather than a literal in two guards, because the two have to agree: one sends every
 * scoped session here, the other keeps every *un*scoped session off it. Spelled in two places, the
 * day one of them is renamed is the day the pair becomes a redirect loop or an open door.
 *
 * Outside `/_authenticated` on purpose — see `app/routes/mfa-enrolment.tsx` for why a screen that
 * needs a session cannot live under the branch that also refuses scoped ones.
 */
export const MFA_ENROLMENT_PATH = '/mfa-enrolment';
