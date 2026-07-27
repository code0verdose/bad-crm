/**
 * A socket failure turned into one line an operator can act on.
 *
 * Not as obvious as it looks. When `localhost` resolves to both `::1` and `127.0.0.1`, Node tries
 * them in parallel and reports the joint failure as an `AggregateError` — whose own `message` is
 * the empty string. Printing `error.message` there produces "postgres (localhost:5433): " and
 * nothing else, which is exactly the unhelpful output the preflight was written to replace.
 *
 * The errno code is preferred over the message on purpose: `ECONNREFUSED` is the same token in
 * every locale and every Node version, and it is what an operator searches for.
 */

const codeOf = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown }).code;

  return typeof code === 'string' && code !== '' ? code : undefined;
};

export const describeSocketError = (error: unknown): string => {
  if (error instanceof AggregateError) {
    const reasons = [...new Set(error.errors.map((inner) => describeSocketError(inner)))];

    return reasons.length > 0 ? reasons.join(', ') : 'connection failed';
  }

  const code = codeOf(error);

  if (code !== undefined) return code;

  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? error.cause : undefined;

  // `fetch` reports every transport problem as `TypeError: fetch failed` and hides the reason in
  // `cause`. Without this the report would say "fetch failed" where it could say "ECONNREFUSED".
  if (cause !== undefined && cause !== null) {
    return message === ''
      ? describeSocketError(cause)
      : `${message}: ${describeSocketError(cause)}`;
  }

  return message === '' ? 'connection failed' : message;
};
