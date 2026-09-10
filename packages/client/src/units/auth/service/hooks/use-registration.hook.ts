import { useTranslation } from 'react-i18next';

import {
  errorMessage,
  type ErrorMessage,
  isApiError,
  VALIDATION_ISSUE_MESSAGE_KEY,
} from '@shared/api';
import { resolveLanguage } from '@shared/i18n';
import { resolveTimeZone } from '@shared/lib';
import { type RegisterFormValues } from '@units/auth/model';
import { useRegisterOrganizationMutation } from '@units/auth/service/mutations';

export interface RegistrationController {
  /** True while the request is in flight — the submit button carries it, nothing else does. */
  readonly isPending: boolean;
  /**
   * The installation refuses new organizations, so there is nothing to fill in any more.
   *
   * **It can only be true after a submit.** Nothing published before a session exists says whether
   * registration is open: `GET /api/v1/meta` answers an API version and a clock (`ApiMeta` in
   * `docs/api/openapi.yaml`) and nothing else, and `REGISTRATION_OPEN` is server-side environment
   * the contract does not expose. So the screen offers the form, and takes it away the moment the
   * installation says 403 — which is the honest version of «форма недоступна». A probe invented for
   * the purpose would be a new public endpoint answering «does this installation have an
   * organization yet», and that answer is exactly what a closed installation is refusing to give.
   */
  readonly isClosed: boolean;
  /** A refusal that belongs to the slug field — the slug is taken. */
  readonly slugError: ErrorMessage | undefined;
  /** A refusal that belongs to the password field — the server's half of the policy said no. */
  readonly passwordError: ErrorMessage | undefined;
  /**
   * A refusal that belongs to no field, shown above them.
   *
   * The pair, not the key: `rate_limited` is the one sentence with a place for a value, and the
   * value is the `Retry-After` the server sent. The form calls `t(key, values)`; until 2026-09-06
   * this was a key alone and the fourth attempt printed «Try again in {{seconds}} s.».
   */
  readonly notice: ErrorMessage | undefined;
  readonly submit: (values: RegisterFormValues) => void;
}

/** Which of the four places a refusal is rendered in. Derived from the answer, never stored. */
const codeOf = (error: unknown): string | undefined => (isApiError(error) ? error.code : undefined);

/**
 * The field the contract names for the owner's password — the only field a `422` can point at that
 * this form has. Joined at runtime rather than written as `'owner.password'`: the catalogue-parity
 * gate reads every dotted literal under `src/` as a translation key, and this one is a JSON path.
 */
const OWNER_PASSWORD = ['owner', 'password'].join('.');

/**
 * The server's verdict on the password, when a `422` names that field.
 *
 * `custom` on this field has exactly one producer — `isWeakPassword` in the registration use-case —
 * and the client applies the same check from `@bad-crm/shared` before it sends anything, so this
 * branch is reached only by a bundle older than the server. Its sentence is the one the client's
 * own schema would have shown, so the person reads the same refusal either way. Every other code
 * is a bound (`too_small`, `too_big`) and reads through the written-out map, like a refused change
 * of password does (`password-change-failure.util.ts`).
 */
const passwordVerdict = (error: unknown): ErrorMessage | undefined => {
  if (!isApiError(error) || error.code !== 'validation_failed') return undefined;

  const issue = error.issues.find((candidate) => candidate.path === OWNER_PASSWORD);

  if (issue === undefined) return undefined;

  return issue.code === 'custom'
    ? { key: 'validation.password.weak' }
    : { key: VALIDATION_ISSUE_MESSAGE_KEY[issue.code] };
};

/**
 * Registering an organization, as the object a public screen can render — the unit's public API for
 * `ui` (`rules/frontend-fsd.mdc` rule 6).
 *
 * **The request body is built here.** The form owns five fields; the contract nests them under
 * `organization` and `owner` and asks for a locale and a time zone that no field does — the
 * interface already knows both — and a page assembling that in its JSX is rule 5 broken
 * (`use-invitation-acceptance.hook.ts` says the same about the same mistake).
 *
 * The confirmation field stops here: `RegisterOrganizationRequest` has no such property, and it
 * exists to catch a typo while it is still a typo, not to be sent.
 *
 * **Every state is read from the mutation at render**, never copied into state by an effect
 * (rule 11): which of the four refusals happened is a function of the error the mutation already
 * holds, and a second copy would survive the next submit that cleared the first.
 *
 * **A `422` naming the password goes under the password.** The server keeps the half of the policy
 * it can rate-limit (`register-organization.use-case.ts`), and its verdict is a statement about one
 * field. Left to the notice it would read «check the highlighted fields» above a form with nothing
 * highlighted — which is what it did until 2026-09-06. A `422` naming nothing this form has still
 * goes to the notice, so a refusal is never silent.
 *
 * `submit` returns nothing and never rejects: `mutate`, not `mutateAsync`. Where the new session
 * lands is not decided here either — registering records the session and asks the router to
 * re-check its guards, and `redirectIfAuthed` on `/register` carries the owner into the application.
 */
export const useRegistration = (): RegistrationController => {
  const { i18n } = useTranslation();
  const mutation = useRegisterOrganizationMutation();

  const code = codeOf(mutation.error);
  const passwordError = passwordVerdict(mutation.error);

  return {
    isPending: mutation.isPending,
    isClosed: code === 'registration_disabled',

    slugError: code === 'organization_already_exists' ? errorMessage(mutation.error) : undefined,

    passwordError,

    notice:
      mutation.error === null ||
      code === 'registration_disabled' ||
      code === 'organization_already_exists' ||
      passwordError !== undefined
        ? undefined
        : errorMessage(mutation.error),

    submit: (values) => {
      mutation.mutate({
        organization: { name: values.organizationName, slug: values.slug },
        owner: {
          email: values.email,
          password: values.password,
          // Not fields: the language is the one the form is being read in, and the zone is the
          // browser's. Asking for either would be asking somebody to retype what the interface can
          // already see (`resolveLanguage` narrows `ru-RU` and `cimode` to a locale the
          // installation ships).
          locale: resolveLanguage(i18n.language),
          timezone: resolveTimeZone(),
        },
      });
    },
  };
};
