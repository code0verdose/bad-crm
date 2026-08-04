import { listFormatter } from './intl-cache.util.js';

/**
 * `['Ада', 'Борис', 'Вера']` → `Ада, Борис и Вера` / `Ada, Boris, and Vera`.
 *
 * `join(', ')` is shorter and wrong in both languages: English wants «and» before the last item
 * (with the serial comma), Russian wants «и» and no comma before it. The rule that produces both is
 * data in the locale, not a branch in a component.
 */
export const formatList = (items: readonly string[], locale: string): string =>
  listFormatter(locale, { style: 'long', type: 'conjunction' }).format(items);
