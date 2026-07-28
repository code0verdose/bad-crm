import { randomUUID } from 'node:crypto';
import { ulid } from 'ulid';

import { type IdGeneratorPort } from '@/application/platform/ports/id-generator.port.js';

/**
 * `IdGeneratorPort` on the platform's own primitives: ULID for correlation identifiers, UUID for
 * entity keys.
 *
 * Named after the platform rather than after one of the two formats, beside `SystemClockAdapter`.
 * It was `UlidIdGeneratorAdapter` while half its surface returned uuids — a file name that tells a
 * reader the opposite of what the module does.
 *
 * ULID for the first kind because those identifiers are read by people: it sorts by creation time,
 * so a request id in a log tells an operator *when* it happened, and it is case-insensitive
 * Crockford base32 — copy-pasteable out of a support ticket without ambiguity between `0` and `O`.
 *
 * UUID for the second kind because that is what the columns are. Every `id` in
 * `docs/architecture/data-model.md` is `uuid`, and `gen_random_uuid()` is the default the first
 * migration writes — `randomUUID()` produces the same shape from the application side, for the one
 * row that cannot let the database generate its own key.
 *
 * **Why v4 and not v7.** `docs/architecture/data-model.md` («Первичные и внешние ключи») prefers
 * UUIDv7 for the *schema* — time-ordered keys append to the right-hand edge of a B-tree instead of
 * fragmenting it — and settles on `gen_random_uuid()` until an installation can be relied on to
 * provide v7. This adapter is not that decision. The only key the application generates is the id
 * of an organization: a table that gains rows at the rate an installation gains tenants, where
 * insert locality is worth nothing. Emitting v7 from here alone would put two key formats into one
 * column family and pre-empt a schema-wide choice from a single adapter. What the bootstrap path
 * depends on is unguessability — the value names a tenant scope before the row exists — and
 * `randomUUID()` is CSPRNG-backed, so that property holds either way.
 */
export class SystemIdGeneratorAdapter implements IdGeneratorPort {
  next(): string {
    return ulid();
  }

  uuid(): string {
    return randomUUID();
  }
}
