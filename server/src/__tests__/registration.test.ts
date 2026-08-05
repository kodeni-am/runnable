import { describe, it, expect } from 'vitest';
import { validateRegistrationInput } from '../services/auth.service';

describe('validateRegistrationInput', () => {
    const ok = { email: 'user@example.com', username: 'johndoe', password: 'hunter2hunter2' };

    it('accepts a well-formed registration', () => {
        expect(validateRegistrationInput(ok.email, ok.username, ok.password)).toEqual(ok);
    });

    // The bug that let `x` / `x` through: the API trusted the browser form.
    it('rejects the single-character payload that bypassed the browser form', () => {
        expect(() => validateRegistrationInput('x', 'x', 'x')).toThrow(/valid email/i);
    });

    describe('email', () => {
        it('trims and lowercases so casing cannot fork an account', () => {
            const result = validateRegistrationInput('  User@Example.COM  ', ok.username, ok.password);
            expect(result.email).toBe('user@example.com');
        });

        it('rejects an address with no domain part', () => {
            expect(() => validateRegistrationInput('user@', ok.username, ok.password)).toThrow(/valid email/i);
        });

        it('rejects an address with no TLD', () => {
            expect(() => validateRegistrationInput('user@example', ok.username, ok.password)).toThrow(/valid email/i);
        });

        it('rejects an address containing whitespace', () => {
            expect(() => validateRegistrationInput('us er@example.com', ok.username, ok.password)).toThrow(/valid email/i);
        });

        it('rejects empty and non-string input', () => {
            expect(() => validateRegistrationInput('', ok.username, ok.password)).toThrow(/valid email/i);
            expect(() => validateRegistrationInput(null, ok.username, ok.password)).toThrow(/valid email/i);
            expect(() => validateRegistrationInput({}, ok.username, ok.password)).toThrow(/valid email/i);
        });

        it('rejects an absurdly long address', () => {
            const long = `${'a'.repeat(250)}@example.com`;
            expect(() => validateRegistrationInput(long, ok.username, ok.password)).toThrow(/valid email/i);
        });
    });

    describe('username', () => {
        it('trims surrounding whitespace', () => {
            expect(validateRegistrationInput(ok.email, '  johndoe  ', ok.password).username).toBe('johndoe');
        });

        it('accepts letters, digits, hyphens and underscores', () => {
            expect(validateRegistrationInput(ok.email, 'a_b-c9', ok.password).username).toBe('a_b-c9');
        });

        it('rejects anything shorter than 3 characters', () => {
            expect(() => validateRegistrationInput(ok.email, 'ab', ok.password)).toThrow(/3 and 32/i);
        });

        it('rejects anything longer than 32 characters', () => {
            expect(() => validateRegistrationInput(ok.email, 'a'.repeat(33), ok.password)).toThrow(/3 and 32/i);
        });

        it('rejects spaces and punctuation', () => {
            expect(() => validateRegistrationInput(ok.email, 'john doe', ok.password)).toThrow(/letters, numbers/i);
            expect(() => validateRegistrationInput(ok.email, 'john@doe', ok.password)).toThrow(/letters, numbers/i);
            expect(() => validateRegistrationInput(ok.email, '../etc', ok.password)).toThrow(/letters, numbers/i);
        });

        it('rejects a leading or trailing separator', () => {
            expect(() => validateRegistrationInput(ok.email, '-johndoe', ok.password)).toThrow(/letters, numbers/i);
            expect(() => validateRegistrationInput(ok.email, 'johndoe_', ok.password)).toThrow(/letters, numbers/i);
        });

        it('preserves case rather than folding it', () => {
            expect(validateRegistrationInput(ok.email, 'JohnDoe', ok.password).username).toBe('JohnDoe');
        });
    });

    describe('password', () => {
        it('rejects anything shorter than 8 characters', () => {
            expect(() => validateRegistrationInput(ok.email, ok.username, 'short12')).toThrow(/at least 8/i);
        });

        it('accepts exactly 8 characters', () => {
            expect(validateRegistrationInput(ok.email, ok.username, '12345678').password).toBe('12345678');
        });

        // An unauthenticated endpoint must not hand bcrypt an unbounded string.
        it('rejects an unbounded password', () => {
            expect(() => validateRegistrationInput(ok.email, ok.username, 'a'.repeat(201))).toThrow(/200 characters/i);
        });

        it('does not trim the password', () => {
            expect(validateRegistrationInput(ok.email, ok.username, '  spaced  ').password).toBe('  spaced  ');
        });
    });
});
