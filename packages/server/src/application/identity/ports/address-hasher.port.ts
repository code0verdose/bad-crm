/**
 * The stored form of a peer address.
 *
 * `Session.ipHash` answers one question — "is this the same address as that other session" — and it
 * has to answer it without the address being recoverable from a database dump. A bare SHA-256 would
 * not: the IPv4 space is 2^32, which a laptop enumerates in seconds, so the digest is keyed. The
 * readable half is `Session.ipMasked`, computed by `domain/identity/mask-ip-address.util.ts`.
 */
export interface AddressHasherPort {
  /** A keyed digest of the address; a stable value for "no address at all". */
  hash(address: string | undefined): string;
}
