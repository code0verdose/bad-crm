import { stdSerializers } from 'pino';

/** Shape pino writes for a thrown value. */
export interface SerializedLogError {
  readonly type?: string;
  readonly message: string;
  readonly stack?: string;
  readonly [key: string]: unknown;
}

/** An error decorated by an HTTP client with the request it failed on. */
interface ErrorWithRequestConfig {
  config?: { headers?: unknown; [key: string]: unknown };
}

/**
 * Error serializer for pino, with one addition to the standard one.
 *
 * HTTP clients attach the failed request to the error they throw, and that request carries the
 * `Authorization` header of the integration — an AI provider key, a GitHub token, an SMTP password.
 * Logged together with the stack trace, it ends up in every aggregator, and `redact` does not stop
 * it: the header sits inside an arbitrary `config.headers` object under a key nobody enumerated.
 *
 * So the headers are dropped entirely rather than filtered by name: the URL and the method are what
 * make the log line useful, and no header is worth the risk of a new client naming its credential
 * something the redaction list has not heard of.
 */
export const serializeLogError = (error: unknown): SerializedLogError => {
  if (!(error instanceof Error)) {
    return { message: typeof error === 'string' ? error : JSON.stringify(error) };
  }

  const serialized = stdSerializers.err(error) as unknown as SerializedLogError &
    ErrorWithRequestConfig;

  if (serialized.config === undefined) return serialized;

  const { headers: _headers, ...config } = serialized.config;

  return { ...serialized, config };
};
