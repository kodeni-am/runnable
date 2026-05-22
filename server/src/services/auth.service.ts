import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { AppDataSource } from '../config/data-source';
import { User, Role } from '../entities';
import { config } from '../config';
import { AppError } from '../middleware/errorHandler';
import { JwtPayload } from '../middleware/auth';

const userRepo = () => AppDataSource.getRepository(User);

export class AuthService {
    static async register(email: string, username: string, password: string): Promise<{ user: User; accessToken: string; refreshToken: string }> {
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
            throw new AppError('Invalid credentials', 401);
        }

        const isValid = await bcrypt.compare(password, user.passwordHash);
        if (!isValid) {
            throw new AppError('Invalid credentials', 401);
        }

        const tokens = AuthService.generateTokens(user);
        return { user, ...tokens };
    }

    static async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
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
        await userRepo().save(user);
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
        await userRepo().save(user);
        return user;
    }

    static async findOrCreateOAuthUser(profile: {
        provider: 'github' | 'google';
        id: string;
        email: string;
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
            } catch (e) {
                // If token is invalid/expired, we'll just fall back to email matching
            }
        }

        // Fallback: Check if account exists by OAuth ID
        if (!user) {
            user = await userRepo().findOne({ where: { [field]: profile.id } });

            if (!user) {
                // Check if user exists with same email
                user = await userRepo().findOne({ where: { email: profile.email } });

                if (user) {
                    // Link OAuth account to existing user by email
                    (user as any)[field] = profile.id;
                    if (profile.provider === 'github' && profile.oauthAccessToken) {
                        user.githubToken = profile.oauthAccessToken;
                    }
                    await userRepo().save(user);
                } else {
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
            return AuthService.generateTokens(user);
        } catch {
            throw new AppError('Invalid refresh token', 401);
        }
    }

    static generateTokens(user: User): { accessToken: string; refreshToken: string } {
        const payload: JwtPayload = { userId: user.id, role: user.role };

        const accessToken = jwt.sign(payload, config.jwt.secret, {
            expiresIn: config.jwt.accessExpiry as any,
        });

        const refreshToken = jwt.sign(payload, config.jwt.refreshSecret, {
            expiresIn: config.jwt.refreshExpiry as any,
        });

        return { accessToken, refreshToken };
    }
}
