import { describe, it, expect } from 'vitest';
import { encryptSecret, decryptSecret } from '../crypto.service';

describe('crypto.service', () => {
    it('round-trips a secret', () => {
        const plain = 'npm_AbCdEf1234567890';
        expect(decryptSecret(encryptSecret(plain))).toBe(plain);
    });

    it('round-trips unicode and empty-ish values', () => {
        expect(decryptSecret(encryptSecret('tökén-✓'))).toBe('tökén-✓');
        expect(decryptSecret(encryptSecret(' '))).toBe(' ');
    });

    it('produces different ciphertext each call (random IV)', () => {
        const a = encryptSecret('same-input');
        const b = encryptSecret('same-input');
        expect(a).not.toBe(b);
        expect(decryptSecret(a)).toBe('same-input');
        expect(decryptSecret(b)).toBe('same-input');
    });

    it('emits the v1 four-part format', () => {
        const parts = encryptSecret('x').split('.');
        expect(parts).toHaveLength(4);
        expect(parts[0]).toBe('v1');
    });

    it('rejects a tampered ciphertext', () => {
        const [v, iv, tag, ct] = encryptSecret('secret-value').split('.');
        const flipped = ct[0] === 'A' ? `B${ct.slice(1)}` : `A${ct.slice(1)}`;
        expect(() => decryptSecret(`${v}.${iv}.${tag}.${flipped}`)).toThrow();
    });

    it('rejects a tampered auth tag', () => {
        const [v, iv, tag, ct] = encryptSecret('secret-value').split('.');
        const flipped = tag[0] === 'A' ? `B${tag.slice(1)}` : `A${tag.slice(1)}`;
        expect(() => decryptSecret(`${v}.${iv}.${flipped}.${ct}`)).toThrow();
    });

    it('rejects an unknown version prefix', () => {
        const parts = encryptSecret('secret-value').split('.');
        parts[0] = 'v2';
        expect(() => decryptSecret(parts.join('.'))).toThrow();
    });

    it('rejects a malformed payload', () => {
        expect(() => decryptSecret('not-a-payload')).toThrow();
        expect(() => decryptSecret('')).toThrow();
        expect(() => decryptSecret('v1.a.b')).toThrow();
    });
});
