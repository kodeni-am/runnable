import { Router, Request, Response, NextFunction } from 'express';
import passport from 'passport';
import { Strategy as GitHubStrategy } from 'passport-github2';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import rateLimit from 'express-rate-limit';
import { AuthService } from '../services/auth.service';
import { authenticate, AuthRequest } from '../middleware/auth';
import { config } from '../config';

const router = Router();

// Rate limiters to prevent brute-force and flooding
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // 10 attempts per window
    message: { error: 'Too many attempts, please try again later' },
    standardHeaders: true,
    legacyHeaders: false,
});

const refreshLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30, // More generous for token refresh
    message: { error: 'Too many refresh attempts' },
    standardHeaders: true,
    legacyHeaders: false,
});

// --- Passport strategies ---
if (config.github.clientId) {
    passport.use(
        new GitHubStrategy(
            {
                clientID: config.github.clientId,
                clientSecret: config.github.clientSecret,
                callbackURL: config.github.callbackUrl,
                scope: ['user:email', 'repo'],
                passReqToCallback: true,
            } as any, // Typecast to any to bypass passport-github2 type definitions missing passReqToCallback
            async (req: any, _accessToken: string, _refreshToken: string, profile: any, done: any) => {
                try {
                    const email = profile.emails?.[0]?.value || `${profile.username}@github.local`;

                    // Extract token from state if provided for linking
                    let reqToken: string | undefined;
                    try {
                        if (req.query && req.query.state) {
                            const stateDecoded = JSON.parse(Buffer.from(req.query.state, 'base64').toString('ascii'));
                            if (stateDecoded.token) {
                                reqToken = stateDecoded.token;
                            }
                        }
                    } catch (e) { }

                    const result = await AuthService.findOrCreateOAuthUser({
                        provider: 'github',
                        id: profile.id,
                        email,
                        username: profile.username,
                        token: reqToken,
                        oauthAccessToken: _accessToken,
                    } as any);
                    done(null, result);
                } catch (error) {
                    done(error);
                }
            }
        )
    );
}

if (config.google.clientId) {
    passport.use(
        new GoogleStrategy(
            {
                clientID: config.google.clientId,
                clientSecret: config.google.clientSecret,
                callbackURL: config.google.callbackUrl,
                scope: ['profile', 'email'],
                passReqToCallback: true,
            } as any,
            async (req: any, _accessToken: string, _refreshToken: string, profile: any, done: any) => {
                try {
                    const email = profile.emails?.[0]?.value;
                    if (!email) {
                        return done(new Error('No email provided'));
                    }

                    // Extract token from state if provided for linking
                    let reqToken: string | undefined;
                    try {
                        if (req.query && req.query.state) {
                            const stateDecoded = JSON.parse(Buffer.from(req.query.state, 'base64').toString('ascii'));
                            if (stateDecoded.token) {
                                reqToken = stateDecoded.token;
                            }
                        }
                    } catch (e) { }

                    const result = await AuthService.findOrCreateOAuthUser({
                        provider: 'google',
                        id: profile.id,
                        email,
                        username: profile.displayName?.replace(/\s+/g, '-').toLowerCase() || `user-${profile.id}`,
                        token: reqToken,
                        oauthAccessToken: _accessToken,
                    } as any);
                    done(null, result);
                } catch (error) {
                    done(error as Error);
                }
            }
        )
    );
}

// --- Cookie helper ---
const isProduction = config.nodeEnv === 'production';

function setAuthCookies(res: Response, accessToken: string, refreshToken: string) {
    res.cookie('accessToken', accessToken, {
        httpOnly: true,
        secure: isProduction,
        sameSite: 'lax',
        maxAge: 15 * 60 * 1000, // 15 min
        path: '/',
    });
    res.cookie('refreshToken', refreshToken, {
        httpOnly: true,
        secure: isProduction,
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        path: '/',
    });
}

function clearAuthCookies(res: Response) {
    res.clearCookie('accessToken', { httpOnly: true, secure: isProduction, sameSite: 'lax', path: '/' });
    res.clearCookie('refreshToken', { httpOnly: true, secure: isProduction, sameSite: 'lax', path: '/' });
}

// --- Route handlers ---

// Register
router.post('/register', authLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { email, username, password } = req.body;
        if (!email || !username || !password) {
            res.status(400).json({ error: 'Email, username, and password are required' });
            return;
        }
        const result = await AuthService.register(email, username, password);
        setAuthCookies(res, result.accessToken, result.refreshToken);
        res.status(201).json({
            user: { id: result.user.id, email: result.user.email, username: result.user.username, role: result.user.role },
        });
    } catch (error) {
        next(error);
    }
});

// Login
router.post('/login', authLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            res.status(400).json({ error: 'Email and password are required' });
            return;
        }
        const result = await AuthService.login(email, password);
        setAuthCookies(res, result.accessToken, result.refreshToken);
        res.json({
            user: { id: result.user.id, email: result.user.email, username: result.user.username, role: result.user.role },
        });
    } catch (error) {
        next(error);
    }
});

// Refresh token (reads refresh token from cookie)
router.post('/refresh', refreshLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const refreshToken = req.cookies?.refreshToken;
        if (!refreshToken) {
            res.status(401).json({ error: 'No refresh token' });
            return;
        }
        const tokens = await AuthService.refreshToken(refreshToken);
        setAuthCookies(res, tokens.accessToken, tokens.refreshToken);
        res.json({ message: 'Tokens refreshed' });
    } catch (error) {
        next(error);
    }
});

// Logout
router.post('/logout', (_req: Request, res: Response) => {
    clearAuthCookies(res);
    res.json({ message: 'Logged out' });
});

// Get current user
router.get('/me', authenticate, (req: AuthRequest, res: Response) => {
    const user = req.user!;
    res.json({
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
        isApproved: user.isApproved,
        githubId: user.githubId || null,
        googleId: user.googleId || null,
    });
});

// Change password
router.post('/change-password', authLimiter, authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!newPassword) {
            res.status(400).json({ error: 'New password is required' });
            return;
        }
        await AuthService.changePassword(req.user!.id, currentPassword || '', newPassword);
        res.json({ message: 'Password updated' });
    } catch (error) {
        next(error);
    }
});

// Change email
router.post('/change-email', authLimiter, authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const { currentPassword, newEmail } = req.body;
        if (!newEmail) {
            res.status(400).json({ error: 'New email is required' });
            return;
        }
        const user = await AuthService.changeEmail(req.user!.id, currentPassword || '', newEmail);
        res.json({ message: 'Email updated', email: user.email });
    } catch (error) {
        next(error);
    }
});

// GitHub OAuth
router.get('/github', (req: Request, res: Response, next: NextFunction) => {
    // Pass accessToken cookie (for linking) and redirect path in state
    const accessToken = req.cookies?.accessToken;
    const redirect = req.query.redirect as string || '';
    const state = Buffer.from(JSON.stringify({ token: accessToken || '', redirect })).toString('base64');
    passport.authenticate('github', { session: false, state })(req, res, next);
});

router.get(
    '/github/callback',
    passport.authenticate('github', { session: false, failureRedirect: '/login' }),
    (req: Request, res: Response) => {
        const result = req.user as any;
        const clientUrl = process.env.CLIENT_URL || 'http://localhost:5175';
        setAuthCookies(res, result.accessToken, result.refreshToken);
        // Redirect to the original page if specified
        let redirect = '/auth/callback';
        try {
            const state = JSON.parse(Buffer.from(req.query.state as string || '', 'base64').toString());
            if (state.redirect) redirect = state.redirect;
        } catch { }
        res.redirect(`${clientUrl}${redirect}`);
    }
);

// Google OAuth
router.get('/google', (req: Request, res: Response, next: NextFunction) => {
    const accessToken = req.cookies?.accessToken;
    const redirect = req.query.redirect as string || '';
    const state = Buffer.from(JSON.stringify({ token: accessToken || '', redirect })).toString('base64');
    passport.authenticate('google', { session: false, scope: ['profile', 'email'], state })(req, res, next);
});

router.get(
    '/google/callback',
    passport.authenticate('google', { session: false, failureRedirect: '/login' }),
    (req: Request, res: Response) => {
        const result = req.user as any;
        const clientUrl = process.env.CLIENT_URL || 'http://localhost:5175';
        setAuthCookies(res, result.accessToken, result.refreshToken);
        let redirect = '/auth/callback';
        try {
            const state = JSON.parse(Buffer.from(req.query.state as string || '', 'base64').toString());
            if (state.redirect) redirect = state.redirect;
        } catch { }
        res.redirect(`${clientUrl}${redirect}`);
    }
);

export default router;
