// The layer that owns the request carrying the token: the property form of the ban has to reach
// here too, not only the auth unit.
export const remember = (token: string): void => {
  globalThis.sessionStorage.setItem('bad_crm_access', token);
};
