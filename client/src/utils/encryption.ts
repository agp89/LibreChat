/**
 * Client-side PBKDF2 key derivation using the browser's native WebCrypto API.
 * The raw passphrase never leaves the browser — only the derived sessionSecret
 * is sent to the server over TLS.
 */

function hexToBuffer(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bufferToHex(buffer: Uint8Array): string {
  return Array.from(buffer)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Derives a 256-bit sessionSecret from the user's encryption passphrase and the
 * server-provided PBKDF2 salt using the browser's native WebCrypto API.
 *
 * This is the client-side half of the passphrase-to-key derivation:
 *   sessionSecret = PBKDF2(passphrase, passphraseSalt, iterations, SHA-256)
 *
 * The returned hex string is sent to `POST /api/auth/unlock-encryption` once per
 * session over TLS. The raw passphrase is never transmitted.
 *
 * @param passphrase - The user's encryption passphrase (UTF-8 string)
 * @param saltHex - 64-character hex string from `GET /api/auth/encryption-salt`
 * @param iterations - PBKDF2 iteration count (default: 600,000 per OWASP 2023)
 * @returns 64-character hex string (256-bit sessionSecret)
 */
export async function deriveSessionSecret(
  passphrase: string,
  saltHex: string,
  iterations = 600_000,
): Promise<string> {
  const encoder = new TextEncoder();
  const salt = hexToBuffer(saltHex);

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveBits'],
  );

  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    256,
  );

  return bufferToHex(new Uint8Array(bits));
}

/**
 * Validates that a passphrase meets the minimum and maximum length requirements.
 * Uses the same defaults as the server-side policy (§9 of the ENCRYPTION_PRD).
 */
export function validatePassphraseLength(
  passphrase: string,
  minLength = 12,
  maxLength = 128,
): { valid: boolean; error?: 'too_short' | 'too_long' } {
  if (passphrase.length < minLength) return { valid: false, error: 'too_short' };
  if (passphrase.length > maxLength) return { valid: false, error: 'too_long' };
  return { valid: true };
}
