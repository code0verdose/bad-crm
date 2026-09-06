import { POLICY_ROLE_LABEL } from '@units/organization/model';

/**
 * The sentence key for a role reference, or `undefined` when there is none.
 *
 * The report names roles by **key**, and a key may belong to a custom role the organization invented
 * — «security-officer» is a real name and no catalogue will ever hold it. So the answer is two
 * cases and they are stated once here rather than as a conditional inside a table cell
 * (`rules/naming-and-structure.mdc` §D): a system role gets its translation, anything else is shown
 * as the organization spelled it.
 *
 * The alternative — falling back to `role` inside `t()` — would print an untranslated word through
 * the catalogue and make the pseudo-locale gate call it a translated one.
 */
export const policyRoleLabelKey = (role: string): string | undefined =>
  Object.hasOwn(POLICY_ROLE_LABEL, role)
    ? POLICY_ROLE_LABEL[role as keyof typeof POLICY_ROLE_LABEL]
    : undefined;

/**
 * The role filter's options, ready for a select.
 *
 * Here rather than in the component that renders them, so the two-case answer above stays a single
 * decision and the panel keeps to markup and handlers (`rules/frontend-fsd.mdc` rule 10). The
 * translator is passed in because this is not a component and cannot call a hook.
 */
export const policyRoleOptions = (
  roles: readonly string[],
  translate: (key: string) => string,
): readonly { readonly value: string; readonly label: string }[] =>
  roles.map((role) => {
    const labelKey = policyRoleLabelKey(role);

    return { value: role, label: labelKey === undefined ? role : translate(labelKey) };
  });
