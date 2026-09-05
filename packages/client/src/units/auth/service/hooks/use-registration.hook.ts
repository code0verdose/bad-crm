import { useTranslation } from 'react-i18next';

import { errorMessageKey, isApiError } from '@shared/api';
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
  /** i18n key of a refusal that belongs to the slug field — the slug is taken. */
  readonly slugErrorKey: string | undefined;
  /** i18n key of a refusal that belongs to no field, shown above them. */
  readonly noticeKey: string | undefined;
  readonly submit: (values: RegisterFormValues) => void;
}

/** Which of the three places a refusal is rendered in. Derived from the answer, never stored. */
const codeOf = (error: unknown): string | undefined => (isApiError(error) ? error.code : undefined);

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
 * (rule 11): which of the three refusals happened is a function of the error the mutation already
 * holds, and a second copy would survive the next submit that cleared the first.
 *
 * `submit` returns nothing and never rejects: `mutate`, not `mutateAsync`. Where the new session
 * lands is not decided here either — registering records the session and asks the router to
 * re-check its guards, and `redirectIfAuthed` on `/register` carries the owner into the application.
 */
export const useRegistration = (): RegistrationController => {
  const { i18n } = useTranslation();
  const mutation = useRegisterOrganizationMutation();

  const code = codeOf(mutation.error);

  return {
    isPending: mutation.isPending,
    isClosed: code === 'registration_disabled',

    slugErrorKey:
      code === 'organization_already_exists' ? errorMessageKey(mutation.error) : undefined,

    noticeKey:
      mutation.error === null ||
      code === 'registration_disabled' ||
      code === 'organization_already_exists'
        ? undefined
        : errorMessageKey(mutation.error),

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
