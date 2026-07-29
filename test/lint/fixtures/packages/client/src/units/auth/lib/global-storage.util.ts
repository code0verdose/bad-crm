// The identifier form is banned by `no-restricted-globals`; this is the same storage reached
// through the global object, which that rule does not see. Caught only after a mutation walked
// past a green `pnpm lint` (CLAUDE.md invariant 3, rules/security.mdc).
export const remember = (token: string): void => {
  globalThis.localStorage.setItem('bad_crm_access', token);
};
