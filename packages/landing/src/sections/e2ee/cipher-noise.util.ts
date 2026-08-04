const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Bytes an XChaCha20-Poly1305 message carries besides the plaintext: 24-byte nonce, 16-byte tag. */
const ENVELOPE_BYTES = 40;

/**
 * A stand-in for ciphertext: deterministic, dense, and telling you nothing about the input except
 * roughly how long it was — which is exactly the property real authenticated encryption has.
 *
 * This is **not** encryption and does not pretend to be: the section demonstrates what the server
 * receives, and shipping a real Argon2id-plus-XChaCha20 implementation to make a paragraph of copy
 * move would be a megabyte of WebAssembly for a picture. What it does reproduce faithfully is the
 * shape — a fixed envelope of nonce and tag around a body the size of the plaintext, and an
 * avalanche: one changed character rewrites the whole string.
 *
 * The avalanche is why the digest is folded over the whole input before any output character is
 * produced, rather than mapping character by character.
 */
export const cipherNoise = (plaintext: string): string => {
  if (plaintext.length === 0) return '';

  let digest = 0x811c9dc5;
  for (const character of plaintext) {
    digest ^= character.codePointAt(0) ?? 0;
    digest = Math.imul(digest, 0x01000193) >>> 0;
  }

  const length = ENVELOPE_BYTES + [...plaintext].length;
  let state = digest;

  return Array.from({ length }, () => {
    // xorshift32: cheap, and its only job here is to look like noise.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return ALPHABET[state % ALPHABET.length];
  }).join('');
};
