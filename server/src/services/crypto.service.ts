import crypto from 'crypto';
import { config } from '../config';
import { AppError } from '../middleware/errorHandler';

// Fixed application salt: the key must be reproducible across restarts and
// across the two self-hosted instances, so it cannot be random per-process.
// Security comes from JWT_SECRET's entropy, not from salt secrecy.
const KEY_SALT = 'runnable.secret.v1';
const VERSION = 'v1';
const IV_BYTES = 12; // GCM standard nonce length

let cachedKey: Buffer | null = null;

// scryptSync is deliberately slow; derive once per process, not per call.
function key(): Buffer {
    if (!cachedKey) {
        cachedKey = crypto.scryptSync(config.jwt.secret, KEY_SALT, 32);
    }
    return cachedKey;
}

/**
 * Encrypt a secret for storage at rest. Returns
 * `v1.<iv>.<authTag>.<ciphertext>`, all base64url.
 */
export function encryptSecret(plaintext: string): string {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
        VERSION,
        iv.toString('base64url'),
        tag.toString('base64url'),
        ciphertext.toString('base64url'),
    ].join('.');
}

/**
 * Decrypt a value produced by encryptSecret. Throws on any malformed,
 * tampered, or unknown-version payload — a wrong JWT_SECRET fails loudly
 * rather than yielding garbage.
 */
export function decryptSecret(payload: string): string {
    const parts = (payload || '').split('.');
    if (parts.length !== 4 || parts[0] !== VERSION) {
        throw new AppError('Could not decrypt secret', 500);
    }
    try {
        const iv = Buffer.from(parts[1], 'base64url');
        const tag = Buffer.from(parts[2], 'base64url');
        const ciphertext = Buffer.from(parts[3], 'base64url');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
        throw new AppError('Could not decrypt secret', 500);
    }
}
