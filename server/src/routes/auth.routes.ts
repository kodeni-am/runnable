import { Router, Request, Response, NextFunction } from 'express';
import passport from 'passport';
import { Strategy as GitHubStrategy } from 'passport-github2';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { AuthService } from '../services/auth.service';
import { authenticate, AuthRequest } from '../middleware/auth';
import { config } from '../config';

const router = Router();

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

// --- Route handlers ---

// Register
router.post('/register', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { email, username, password } = req.body;
        if (!email || !username || !password) {
            res.status(400).json({ error: 'Email, username, and password are required' });
            return;
        }
        const result = await AuthService.register(email, username, password);
        res.status(201).json({
            user: { id: result.user.id, email: result.user.email, username: result.user.username, role: result.user.role },
            accessToken: result.accessToken,
            refreshToken: result.refreshToken,
        });
    } catch (error) {
        next(error);
    }
});

// Login
router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            res.status(400).json({ error: 'Email and password are required' });
            return;
        }
        const result = await AuthService.login(email, password);
        res.json({
            user: { id: result.user.id, email: result.user.email, username: result.user.username, role: result.user.role },
            accessToken: result.accessToken,
            refreshToken: result.refreshToken,
        });
    } catch (error) {
        next(error);
    }
});

// Refresh token
router.post('/refresh', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { refreshToken } = req.body;
        if (!refreshToken) {
            res.status(400).json({ error: 'Refresh token is required' });
            return;
        }
        const tokens = await AuthService.refreshToken(refreshToken);
        res.json(tokens);
    } catch (error) {
        next(error);
    }
});

// Get current user
router.get('/me', authenticate, (req: AuthRequest, res: Response) => {
    const user = req.user!;
    res.json({
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
        githubId: user.githubId || null,
        googleId: user.googleId || null,
    });
});

// GitHub OAuth
// Allow passing an optional token to link to an existing account
router.get('/github', (req: Request, res: Response, next: NextFunction) => {
    const token = req.query.token as string;
    passport.authenticate('github', {
        session: false,
        state: token ? Buffer.from(JSON.stringify({ token })).toString('base64') : undefined
    })(req, res, next);
});

router.get(
    '/github/callback',
    passport.authenticate('github', { session: false, failureRedirect: '/login' }),
    (req: Request, res: Response) => {
        const result = req.user as any;
        // Redirect to frontend with tokens in query params
        const params = new URLSearchParams({
            accessToken: result.accessToken,
            refreshToken: result.refreshToken,
        });
        res.redirect(`${process.env.CLIENT_URL || 'http://localhost:5175'}/auth/callback?${params}`);
    }
);

// Google OAuth
router.get('/google', (req: Request, res: Response, next: NextFunction) => {
    const token = req.query.token as string;
    passport.authenticate('google', {
        session: false,
        scope: ['profile', 'email'],
        state: token ? Buffer.from(JSON.stringify({ token })).toString('base64') : undefined
    })(req, res, next);
});

router.get(
    '/google/callback',
    passport.authenticate('google', { session: false, failureRedirect: '/login' }),
    (req: Request, res: Response) => {
        const result = req.user as any;
        const params = new URLSearchParams({
            accessToken: result.accessToken,
            refreshToken: result.refreshToken,
        });
        res.redirect(`${process.env.CLIENT_URL || 'http://localhost:5175'}/auth/callback?${params}`);
    }
);

export default router;
