import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { AppDataSource } from '../config/data-source';
import { User, Role } from '../entities';
import { config } from '../config';
import { AppError } from '../middleware/errorHandler';
import { JwtPayload } from '../middleware/auth';
import { AppSettingsService } from './appSettings.service';

const userRepo = () => AppDataSource.getRepository(User);

// Compared against when login hits a non-existent account, so response time
// doesn't reveal whether an email is registered.
const DUMMY_HASH = bcrypt.hashSync('runnable-timing-equalizer', 12);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Letters/digits at both ends, separators only in between.
const USERNAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9_-]*[a-zA-Z0-9])?$/;

/**
 * Validate and normalize a self-service registration payload.
 *
 * The signup form validates in the browser (type=email, minLength), but that
 * is decoration — anything POSTing straight to /api/auth/register bypasses it
 * entirely, which is how single-character junk accounts got created. This is
 * the authoritative check.
 *
 * Password registration only: OAuth-provisioned usernames come from the
 * provider and are not required to satisfy USERNAME_RE.
 */
export function validateRegistrationInput(
    rawEmail: unknown,
    rawUsername: unknown,
    rawPassword: unknown,
): { email: string; username: string; password: string } {
    const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
    // 254 is the practical RFC 5321 ceiling for an address.
    if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
        throw new AppError('A valid email address is required', 400);
    }

    const username = typeof rawUsername === 'string' ? rawUsername.trim() : '';
    if (username.length < 3 || username.length > 32) {
        throw new AppError('Username must be between 3 and 32 characters', 400);
    }
    if (!USERNAME_RE.test(username)) {
        throw new AppError(
            'Username may only contain letters, numbers, hyphens and underscores, and must start and end with a letter or number',
            400,
        );
    }

    const password = typeof rawPassword === 'string' ? rawPassword : '';
    if (password.length < 8) {
        throw new AppError('Password must be at least 8 characters', 400);
    }
    // Unauthenticated endpoint — never hand bcrypt an unbounded string.
    if (password.length > 200) {
        throw new AppError('Password must be at most 200 characters', 400);
    }

    return { email, username, password };
}

export class AuthService {
    static async register(rawEmail: string, rawUsername: string, rawPassword: string): Promise<{ user: User; accessToken: string; refreshToken: string }> {
        const { email, username, password } = validateRegistrationInput(rawEmail, rawUsername, rawPassword);

        // Uniqueness is checked against the normalized email, so a casing
        // variant can no longer slip past into a duplicate account.
        const existing = await userRepo().findOne({ where: [{ email }, { username }] });
        if (existing) {
            throw new AppError('User with this email or username already exists', 409);
        }

        const passwordHash = await bcrypt.hash(password, 12);

        const user = userRepo().create({
            email,
            username,
            passwordHash,
            role: Role.USER,
        });

        await userRepo().save(user);

        const tokens = AuthService.generateTokens(user);
        return { user, ...tokens };
    }

    static async login(email: string, password: string): Promise<{ user: User; accessToken: string; refreshToken: string }> {
        const user = await userRepo().findOne({ where: { email } });
        if (!user || !user.passwordHash) {
            await bcrypt.compare(password, DUMMY_HASH);
            throw new AppError('Invalid credentials', 401);
        }

        const isValid = await bcrypt.compare(password, user.passwordHash);
        if (!isValid) {
            throw new AppError('Invalid credentials', 401);
        }

        const tokens = AuthService.generateTokens(user);
        return { user, ...tokens };
    }

    static async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<User> {
        if (!newPassword || newPassword.length < 8) {
            throw new AppError('New password must be at least 8 characters', 400);
        }

        const user = await userRepo().findOne({ where: { id: userId } });
        if (!user) {
            throw new AppError('User not found', 404);
        }

        // Accounts created via OAuth may not have a password yet — let them set one
        // without supplying a current password.
        if (user.passwordHash) {
            const isValid = await bcrypt.compare(currentPassword, user.passwordHash);
            if (!isValid) {
                throw new AppError('Current password is incorrect', 401);
            }
        }

        user.passwordHash = await bcrypt.hash(newPassword, 12);
        // Invalidate every previously issued access/refresh token — changing
        // the password must kill any session an attacker may already hold.
        user.tokenVersion = (user.tokenVersion ?? 0) + 1;
        await userRepo().save(user);
        return user;
    }

    static async changeEmail(userId: string, currentPassword: string, newEmail: string): Promise<User> {
        const email = (newEmail || '').trim();
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            throw new AppError('A valid email address is required', 400);
        }

        const user = await userRepo().findOne({ where: { id: userId } });
        if (!user) {
            throw new AppError('User not found', 404);
        }

        if (email === user.email) {
            throw new AppError('That is already your email address', 400);
        }

        // Verify the current password for password-based accounts.
        // OAuth-only accounts (no password) are allowed to change without one.
        if (user.passwordHash) {
            const isValid = await bcrypt.compare(currentPassword, user.passwordHash);
            if (!isValid) {
                throw new AppError('Current password is incorrect', 401);
            }
        }

        const existing = await userRepo().findOne({ where: { email } });
        if (existing) {
            throw new AppError('That email address is already in use', 409);
        }

        user.email = email;
        // Invalidate existing sessions, same as a password change
        user.tokenVersion = (user.tokenVersion ?? 0) + 1;
        await userRepo().save(user);
        return user;
    }

    static async findOrCreateOAuthUser(profile: {
        provider: 'github' | 'google';
        id: string;
        email: string;
        emailVerified?: boolean; // Whether the provider asserts the email is verified
        username: string;
        token?: string; // The user's current JWT token to link accounts
        oauthAccessToken?: string; // The provider's access token
    }): Promise<{ user: User; accessToken: string; refreshToken: string }> {
        const field = profile.provider === 'github' ? 'githubId' : 'googleId';

        let user: User | null = null;

        // If a JWT token was provided, identify the existing user
        if (profile.token) {
            try {
                const decoded = jwt.verify(profile.token, config.jwt.secret) as JwtPayload;
                user = await userRepo().findOne({ where: { id: decoded.userId } });
                // A token from before a password/email change must not link accounts
                if (user && (decoded.tokenVersion ?? 0) !== (user.tokenVersion ?? 0)) {
                    user = null;
                }
            } catch (e) {
                // If token is invalid/expired, we'll just fall back to email matching
            }
        }

        // Fallback: Check if account exists by OAuth ID
        if (!user) {
            user = await userRepo().findOne({ where: { [field]: profile.id } });

            if (!user) {
                // Check if user exists with same email — but only auto-link when the
                // provider asserts the email is verified, otherwise an attacker could
                // claim someone else's email on the provider and take over the account.
                const existingByEmail = await userRepo().findOne({ where: { email: profile.email } });
                if (existingByEmail && !profile.emailVerified) {
                    throw new AppError(
                        'An account with this email already exists. Log in with your password and link this provider from Settings.',
                        409
                    );
                }
                user = existingByEmail;

                if (user) {
                    // Link OAuth account to existing user by email
                    (user as any)[field] = profile.id;
                    if (profile.provider === 'github' && profile.oauthAccessToken) {
                        user.githubToken = profile.oauthAccessToken;
                    }
                    await userRepo().save(user);
                } else {
                    // No existing account to link — this is a brand-new signup, so
                    // it is subject to the same gate as the password form. Without
                    // this, "Sign in with GitHub" would walk straight past it.
                    if (!(await AppSettingsService.allowsPublicRegistration())) {
                        throw new AppError('Registration is closed on this instance', 403);
                    }

                    // Create new user
                    let username = profile.username;
                    const existingUsername = await userRepo().findOne({ where: { username } });
                    if (existingUsername) {
                        username = `${username}-${Date.now()}`;
                    }

                    user = userRepo().create({
                        email: profile.email,
                        username,
                        [field]: profile.id,
                        githubToken: profile.provider === 'github' ? profile.oauthAccessToken : undefined,
                        role: Role.USER,
                    });
                    await userRepo().save(user);
                }
            } else {
                // User exists by OAuth ID, just update token if needed
                if (profile.provider === 'github' && profile.oauthAccessToken) {
                    user.githubToken = profile.oauthAccessToken;
                    await userRepo().save(user);
                }
            }
        } else {
            // User exists by JWT Token (linking), just update their OAuth link
            (user as any)[field] = profile.id;
            if (profile.provider === 'github' && profile.oauthAccessToken) {
                user.githubToken = profile.oauthAccessToken;
            }
            await userRepo().save(user);
        }

        const tokens = AuthService.generateTokens(user!);
        return { user, ...tokens };
    }

    static async refreshToken(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
        try {
            const decoded = jwt.verify(refreshToken, config.jwt.refreshSecret) as JwtPayload;
            const user = await userRepo().findOne({ where: { id: decoded.userId } });
            if (!user) {
                throw new AppError('User not found', 401);
            }
            if ((decoded.tokenVersion ?? 0) !== (user.tokenVersion ?? 0)) {
                throw new AppError('Session invalidated', 401);
            }
            return AuthService.generateTokens(user);
        } catch {
            throw new AppError('Invalid refresh token', 401);
        }
    }

    static generateTokens(user: User): { accessToken: string; refreshToken: string } {
        const payload: JwtPayload = { userId: user.id, role: user.role, tokenVersion: user.tokenVersion ?? 0 };

        const accessToken = jwt.sign(payload, config.jwt.secret, {
            expiresIn: config.jwt.accessExpiry as any,
        });

        const refreshToken = jwt.sign(payload, config.jwt.refreshSecret, {
            expiresIn: config.jwt.refreshExpiry as any,
        });

        return { accessToken, refreshToken };
    }
}
