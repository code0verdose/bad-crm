import { useTranslation } from 'react-i18next';

export interface ToastMessageProps {
  readonly messageKey: string;
  readonly values?: Readonly<Record<string, string | number>>;
}

/**
 * The sentence inside a toast, resolved where the i18n context lives.
 *
 * `notify` is a module-level utility — it is called from `MutationCache.onError`, which is not a
 * component and has no context to read. Handing it an instance through a module variable would work
 * and would be a second source of truth for «which i18next is this application using»; the instance
 * is injectable (`Providers`) precisely so that there is only one answer, and a module-level copy
 * would go stale the moment a test injected a different one.
 *
 * So the toast carries a node instead of a string. Mantine renders `message` inside its own tree,
 * which sits under `I18nextProvider`, and the translation happens in a component the way every
 * other translation in this application does.
 */
export function ToastMessage({ messageKey, values }: ToastMessageProps) {
  const { t } = useTranslation();

  return <>{t(messageKey, values ?? {})}</>;
}
