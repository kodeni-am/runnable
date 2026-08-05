import { describe, it, expect } from 'vitest';
import { sandboxConfigError } from '../index';

// The sandbox is what stops a user project's `npm install` — and any
// compromised dependency's postinstall hook — from running as the server's
// own (root) identity. It is opt-in via SANDBOX_ENABLED, so a missing or
// misspelled env var silently downgrades to root execution. In production
// that must stop the boot, not proceed quietly.
describe('sandboxConfigError', () => {
    it('rejects production with the sandbox disabled', () => {
        const err = sandboxConfigError({ nodeEnv: 'production', sandboxEnabled: false, allowUnsafe: false });
        expect(err).toMatch(/SANDBOX_ENABLED/);
    });

    it('names the escape hatch so the operator can see the way out', () => {
        const err = sandboxConfigError({ nodeEnv: 'production', sandboxEnabled: false, allowUnsafe: false });
        expect(err).toMatch(/SANDBOX_ALLOW_UNSAFE/);
    });

    it('accepts production with the sandbox enabled', () => {
        expect(sandboxConfigError({ nodeEnv: 'production', sandboxEnabled: true, allowUnsafe: false })).toBeNull();
    });

    it('accepts production with the sandbox disabled but explicitly overridden', () => {
        expect(sandboxConfigError({ nodeEnv: 'production', sandboxEnabled: false, allowUnsafe: true })).toBeNull();
    });

    it('leaves development alone so local work needs no sudo setup', () => {
        expect(sandboxConfigError({ nodeEnv: 'development', sandboxEnabled: false, allowUnsafe: false })).toBeNull();
        expect(sandboxConfigError({ nodeEnv: 'test', sandboxEnabled: false, allowUnsafe: false })).toBeNull();
    });

    // The override exists for operators who deliberately accept the risk;
    // it must not also suppress the enabled-sandbox happy path.
    it('is a no-op when the sandbox is already enabled', () => {
        expect(sandboxConfigError({ nodeEnv: 'production', sandboxEnabled: true, allowUnsafe: true })).toBeNull();
    });
});
