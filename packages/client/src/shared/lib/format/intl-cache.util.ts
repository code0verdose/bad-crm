/**
 * One `Intl` formatter per distinct configuration, kept for the life of the tab.
 *
 * Constructing an `Intl.*` formatter is expensive — it resolves a locale, loads the data for it and
 * builds a pattern — and the call sites here are table cells: a list of a hundred rows with three
 * dates each builds three hundred formatters per render without this. Caching them is the
 * recommendation in the `Intl` specification itself, not a micro-optimisation invented here.
 *
 * The key is the constructor arguments, so two call sites asking for the same thing share one
 * instance and a change in options gets its own.
 */
const cached = <T>(store: Map<string, T>, key: string, build: () => T): T => {
  const existing = store.get(key);

  if (existing !== undefined) return existing;

  const created = build();
  store.set(key, created);

  return created;
};

const dateFormatters = new Map<string, Intl.DateTimeFormat>();
const numberFormatters = new Map<string, Intl.NumberFormat>();
const listFormatters = new Map<string, Intl.ListFormat>();
const relativeFormatters = new Map<string, Intl.RelativeTimeFormat>();

export const dateFormatter = (locale: string, options: Intl.DateTimeFormatOptions) =>
  cached(
    dateFormatters,
    `${locale}|${JSON.stringify(options)}`,
    () => new Intl.DateTimeFormat(locale, options),
  );

export const numberFormatter = (locale: string, options: Intl.NumberFormatOptions) =>
  cached(
    numberFormatters,
    `${locale}|${JSON.stringify(options)}`,
    () => new Intl.NumberFormat(locale, options),
  );

export const listFormatter = (locale: string, options: Intl.ListFormatOptions) =>
  cached(
    listFormatters,
    `${locale}|${JSON.stringify(options)}`,
    () => new Intl.ListFormat(locale, options),
  );

export const relativeTimeFormatter = (locale: string, options: Intl.RelativeTimeFormatOptions) =>
  cached(
    relativeFormatters,
    `${locale}|${JSON.stringify(options)}`,
    () => new Intl.RelativeTimeFormat(locale, options),
  );
