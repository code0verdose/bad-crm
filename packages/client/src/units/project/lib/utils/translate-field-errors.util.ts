import { type ErrorMessage } from '@shared/api';

export type TranslateMessage = (key: string, values: Readonly<Record<string, number>>) => string;

/**
 * The server's per-field refusals as the strings a Mantine input takes as its `error`.
 *
 * Outside the component on purpose (`rules/naming-and-structure.mdc`, «no helpers inside a
 * component»): the form merges these with its own issues — its own first, because a value the form
 * itself refuses has to be fixed before the server's verdict about it could even be true.
 * `t(key, values)`, never `t(key)`: a sentence with a place for a number keeps it.
 */
export const translateFieldErrors = <Field extends string>(
  fields: Partial<Readonly<Record<Field, ErrorMessage>>>,
  translate: TranslateMessage,
): Partial<Record<Field, string>> => {
  const translated: Partial<Record<Field, string>> = {};

  for (const [field, message] of Object.entries(fields) as [Field, ErrorMessage | undefined][]) {
    if (message !== undefined) translated[field] = translate(message.key, message.values ?? {});
  }

  return translated;
};
