import { ulid } from 'ulid';

import { type IdGeneratorPort } from '@/application/platform/ports/id-generator.port.js';

/**
 * `IdGeneratorPort` on ULID.
 *
 * ULID over UUIDv4 because the identifiers are also index keys: a ULID sorts by creation time, so
 * inserts land at the end of a B-tree instead of scattering across it, and a request identifier
 * read from a log tells an operator *when* it happened. It is also case-insensitive Crockford
 * base32 — copy-pasteable out of a support ticket without ambiguity between `0` and `O`.
 */
export class UlidIdGeneratorAdapter implements IdGeneratorPort {
  next(): string {
    return ulid();
  }
}
