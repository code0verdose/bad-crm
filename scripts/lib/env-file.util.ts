/**
 * Minimal `.env` reader.
 *
 * Deliberately not `dotenv`: the file is read by two development scripts, the grammar this project
 * actually uses is four lines of code, and the value is handed straight to the Zod schema that
 * already owns every rule about it. A dependency here would also have to be loaded before the
 * schema could reject it, which is the wrong order.
 *
 * Multi-line values are not supported: `.env.example` has none, and silently mis-parsing one is
 * worse than not accepting it.
 */

const ASSIGNMENT = /^(?:export\s+)?(?<key>[A-Za-z_][A-Za-z0-9_]*)=(?<value>.*)$/;

/** A `#` starts a comment only after whitespace, so `pass#word` survives. */
const TRAILING_COMMENT = /\s+#.*$/;

const unquote = (value: string): string => {
  const quote = value[0];

  return (quote === '"' || quote === "'") && value.length > 1 && value.endsWith(quote)
    ? value.slice(1, -1)
    : value.replace(TRAILING_COMMENT, '');
};

export const parseEnvFile = (contents: string): Record<string, string> => {
  const entries: Record<string, string> = {};

  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const match = ASSIGNMENT.exec(line);
    const key = match?.groups?.['key'];
    if (key === undefined) continue;

    entries[key] = unquote((match?.groups?.['value'] ?? '').trim());
  }

  return entries;
};
