import {
    generateRegistrationOptions,
    verifyRegistrationResponse,
    generateAuthenticationOptions,
    verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { AppDataSource } from '../config/data-source';
import { User } from '../entities';
import { WebAuthnCredential } from '../entities/WebAuthnCredential';
import { config } from '../config';
import { AppError } from '../middleware/errorHandler';
import { AuthService } from './auth.service';

const credRepo = () => AppDataSource.getRepository(WebAuthnCredential);

// rpID is the hostname of the SPA origin; credentials are scoped to it.
const rpID = () => new URL(config.clientUrl).hostname;
const RP_NAME = 'Runnable';

export interface PasskeySummary {
    id: string;
    name: string;
    deviceType: string;
    backedUp: boolean;
    createdAt: Date;
    lastUsedAt: Date | null;
}

function serializePasskey(cred: WebAuthnCredential): PasskeySummary {
    return {
        id: cred.id,
        name: cred.name,
        deviceType: cred.deviceType,
        backedUp: cred.backedUp,
        createdAt: cred.createdAt,
        lastUsedAt: cred.lastUsedAt ?? null,
    };
}

export class PasskeyService {
    static async getRegistrationOptions(user: User) {
        const existing = await credRepo().find({ where: { userId: user.id } });
        return generateRegistrationOptions({
            rpName: RP_NAME,
            rpID: rpID(),
            // Stable per-user handle so an authenticator overwrites its own
            // old passkey for this account instead of accumulating copies.
            userID: new TextEncoder().encode(user.id),
            userName: user.username,
            userDisplayName: user.username,
            attestationType: 'none',
            excludeCredentials: existing.map((c) => ({
                id: c.credentialId,
                transports: c.transports as any,
            })),
            authenticatorSelection: {
                // Discoverable credential, required for one-tap login
                residentKey: 'required',
                userVerification: 'preferred',
            },
        });
    }

    static async verifyRegistration(
        user: User,
        response: unknown,
        name: string,
        expectedChallenge: string
    ): Promise<PasskeySummary> {
        let verification;
        try {
            verification = await verifyRegistrationResponse({
                response: response as any,
                expectedChallenge,
                expectedOrigin: new URL(config.clientUrl).origin,
                expectedRPID: rpID(),
            });
        } catch {
            throw new AppError('Passkey registration could not be verified', 400);
        }
        if (!verification.verified || !verification.registrationInfo) {
            throw new AppError('Passkey registration could not be verified', 400);
        }

        const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

        const dup = await credRepo().findOne({ where: { credentialId: credential.id } });
        if (dup) {
            throw new AppError('This passkey is already registered', 409);
        }

        const record = credRepo().create({
            userId: user.id,
            credentialId: credential.id,
            publicKey: Buffer.from(credential.publicKey).toString('base64url'),
            counter: String(credential.counter),
            transports: credential.transports,
            deviceType: credentialDeviceType,
            backedUp: credentialBackedUp,
            name: (name || '').trim().slice(0, 64) || 'Passkey',
        });
        const saved = await credRepo().save(record);
        return serializePasskey(saved);
    }

    static async listPasskeys(userId: string): Promise<PasskeySummary[]> {
        const creds = await credRepo().find({ where: { userId }, order: { createdAt: 'ASC' } });
        return creds.map(serializePasskey);
    }

    static async deletePasskey(userId: string, id: string): Promise<void> {
        // Scoped by userId so a foreign id 404s — never reveals whether the
        // passkey exists for someone else.
        const result = await credRepo().delete({ id, userId });
        if (!result.affected) {
            throw new AppError('Passkey not found', 404);
        }
    }

    static async getLoginOptions() {
        return generateAuthenticationOptions({
            rpID: rpID(),
            // Empty allowCredentials → discoverable-credential flow: the
            // browser/OS shows its own account picker.
            allowCredentials: [],
            userVerification: 'preferred',
        });
    }

    static async verifyLogin(
        response: unknown,
        expectedChallenge: string
    ): Promise<{ user: User; accessToken: string; refreshToken: string }> {
        const credentialId = (response as any)?.id;
        const cred = typeof credentialId === 'string' && credentialId.length > 0
            ? await credRepo().findOne({ where: { credentialId }, relations: { user: true } })
            : null;
        if (!cred) {
            throw new AppError('Invalid credentials', 401);
        }

        let verification;
        try {
            verification = await verifyAuthenticationResponse({
                response: response as any,
                expectedChallenge,
                expectedOrigin: new URL(config.clientUrl).origin,
                expectedRPID: rpID(),
                credential: {
                    id: cred.credentialId,
                    publicKey: new Uint8Array(Buffer.from(cred.publicKey, 'base64url')),
                    counter: parseInt(cred.counter, 10),
                    transports: cred.transports as any,
                },
            });
        } catch {
            throw new AppError('Invalid credentials', 401);
        }
        if (!verification.verified) {
            throw new AppError('Invalid credentials', 401);
        }

        cred.counter = String(verification.authenticationInfo.newCounter);
        cred.lastUsedAt = new Date();
        await credRepo().save(cred);

        const tokens = AuthService.generateTokens(cred.user);
        return { user: cred.user, ...tokens };
    }
}
