import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@simplewebauthn/server', () => ({
    generateRegistrationOptions: vi.fn(),
    verifyRegistrationResponse: vi.fn(),
    generateAuthenticationOptions: vi.fn(),
    verifyAuthenticationResponse: vi.fn(),
}));
vi.mock('../../config/data-source', () => ({
    AppDataSource: { getRepository: vi.fn() },
}));
vi.mock('../auth.service', () => ({
    AuthService: {
        generateTokens: vi.fn(() => ({ accessToken: 'access', refreshToken: 'refresh' })),
    },
}));

import {
    generateRegistrationOptions,
    verifyRegistrationResponse,
    verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { PasskeyService } from '../passkey.service';
import { AppDataSource } from '../../config/data-source';
import { AuthService } from '../auth.service';
import { WebAuthnCredential } from '../../entities/WebAuthnCredential';

const user = { id: 'user-1', username: 'ara', role: 'user', tokenVersion: 0 } as any;

let credRepo: any;

beforeEach(() => {
    vi.clearAllMocks();
    credRepo = {
        find: vi.fn(async () => []),
        findOne: vi.fn(async () => null),
        create: vi.fn((x: any) => x),
        save: vi.fn(async (x: any) => ({ id: 'cred-row-1', createdAt: new Date(), lastUsedAt: null, ...x })),
        delete: vi.fn(async () => ({ affected: 1 })),
    };
    vi.mocked(AppDataSource.getRepository).mockImplementation((entity: any) => {
        if (entity === WebAuthnCredential) return credRepo;
        throw new Error('unexpected repository');
    });
});

describe('PasskeyService.getRegistrationOptions', () => {
    it('excludes already-registered credentials and requires resident keys', async () => {
        credRepo.find.mockResolvedValue([
            { credentialId: 'existing-cred', transports: ['internal'] },
        ]);
        vi.mocked(generateRegistrationOptions).mockResolvedValue({ challenge: 'chal' } as any);

        await PasskeyService.getRegistrationOptions(user);

        const args = vi.mocked(generateRegistrationOptions).mock.calls[0][0];
        expect(args.excludeCredentials).toEqual([
            { id: 'existing-cred', transports: ['internal'] },
        ]);
        expect(args.authenticatorSelection).toMatchObject({
            residentKey: 'required',
            userVerification: 'preferred',
        });
        expect(args.userName).toBe('ara');
    });
});

describe('PasskeyService.verifyRegistration', () => {
    const verifiedResult = {
        verified: true,
        registrationInfo: {
            credential: {
                id: 'new-cred-id',
                publicKey: new Uint8Array([1, 2, 3]),
                counter: 0,
                transports: ['internal'],
            },
            credentialDeviceType: 'multiDevice',
            credentialBackedUp: true,
        },
    } as any;

    it('stores the credential with base64url public key and default name', async () => {
        vi.mocked(verifyRegistrationResponse).mockResolvedValue(verifiedResult);

        const summary = await PasskeyService.verifyRegistration(user, {}, '   ', 'chal');

        expect(credRepo.create).toHaveBeenCalledWith(expect.objectContaining({
            userId: 'user-1',
            credentialId: 'new-cred-id',
            publicKey: Buffer.from([1, 2, 3]).toString('base64url'),
            counter: '0',
            deviceType: 'multiDevice',
            backedUp: true,
            name: 'Passkey',
        }));
        expect(summary).not.toHaveProperty('publicKey');
        expect(summary).not.toHaveProperty('credentialId');
        expect(summary.name).toBe('Passkey');
        expect(verifyRegistrationResponse).toHaveBeenCalledWith(
            expect.objectContaining({ expectedOrigin: 'http://localhost:5175' })
        );
    });

    it('rejects a duplicate credential with 409', async () => {
        vi.mocked(verifyRegistrationResponse).mockResolvedValue(verifiedResult);
        credRepo.findOne.mockResolvedValue({ id: 'already-there' });

        await expect(PasskeyService.verifyRegistration(user, {}, 'x', 'chal'))
            .rejects.toMatchObject({ statusCode: 409 });
    });

    it('rejects when verification fails', async () => {
        vi.mocked(verifyRegistrationResponse).mockResolvedValue({ verified: false } as any);

        await expect(PasskeyService.verifyRegistration(user, {}, 'x', 'chal'))
            .rejects.toMatchObject({ statusCode: 400 });
    });

    it('rejects when the library throws', async () => {
        vi.mocked(verifyRegistrationResponse).mockRejectedValue(new Error('bad attestation'));

        await expect(PasskeyService.verifyRegistration(user, {}, 'x', 'chal'))
            .rejects.toMatchObject({ statusCode: 400 });
    });
});

describe('PasskeyService.verifyLogin', () => {
    const storedCred = () => ({
        id: 'cred-row-1',
        credentialId: 'known-cred',
        publicKey: Buffer.from([1, 2, 3]).toString('base64url'),
        counter: '5',
        transports: ['internal'],
        user,
        lastUsedAt: null,
    });

    it('returns generic 401 for an unknown credential', async () => {
        credRepo.findOne.mockResolvedValue(null);

        await expect(PasskeyService.verifyLogin({ id: 'nope' }, 'chal'))
            .rejects.toMatchObject({ statusCode: 401, message: 'Invalid credentials' });
        expect(verifyAuthenticationResponse).not.toHaveBeenCalled();
    });

    it('returns generic 401 for a non-string credential id without querying the repository', async () => {
        await expect(PasskeyService.verifyLogin({ id: {} }, 'chal'))
            .rejects.toMatchObject({ statusCode: 401, message: 'Invalid credentials' });
        expect(credRepo.findOne).not.toHaveBeenCalled();
        expect(verifyAuthenticationResponse).not.toHaveBeenCalled();
    });

    it('returns generic 401 when signature verification throws', async () => {
        credRepo.findOne.mockResolvedValue(storedCred());
        vi.mocked(verifyAuthenticationResponse).mockRejectedValue(new Error('bad sig'));

        await expect(PasskeyService.verifyLogin({ id: 'known-cred' }, 'chal'))
            .rejects.toMatchObject({ statusCode: 401, message: 'Invalid credentials' });
    });

    it('updates counter and lastUsedAt and issues tokens on success', async () => {
        const cred = storedCred();
        credRepo.findOne.mockResolvedValue(cred);
        vi.mocked(verifyAuthenticationResponse).mockResolvedValue({
            verified: true,
            authenticationInfo: { newCounter: 6 },
        } as any);

        const result = await PasskeyService.verifyLogin({ id: 'known-cred' }, 'chal');

        expect(credRepo.save).toHaveBeenCalledWith(expect.objectContaining({
            counter: '6',
            lastUsedAt: expect.any(Date),
        }));
        expect(AuthService.generateTokens).toHaveBeenCalledWith(user);
        expect(result).toMatchObject({ user, accessToken: 'access', refreshToken: 'refresh' });
    });
});

describe('PasskeyService.deletePasskey', () => {
    it('deletes only within the owning user scope', async () => {
        await PasskeyService.deletePasskey('user-1', 'cred-row-1');
        expect(credRepo.delete).toHaveBeenCalledWith({ id: 'cred-row-1', userId: 'user-1' });
    });

    it('404s when nothing was deleted', async () => {
        credRepo.delete.mockResolvedValue({ affected: 0 });
        await expect(PasskeyService.deletePasskey('user-1', 'other'))
            .rejects.toMatchObject({ statusCode: 404 });
    });
});
