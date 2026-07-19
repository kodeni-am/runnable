import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { PasskeyService } from '../services/passkey.service';
import { authLimiter, serializeUser, setAuthCookies } from './auth.routes';
import { config } from '../config';

const router = Router();
const isProduction = config.nodeEnv === 'production';

const CHALLENGE_COOKIE = 'webauthnChallenge';

function setChallengeCookie(res: Response, challenge: string) {
    res.cookie(CHALLENGE_COOKIE, challenge, {
        httpOnly: true,
        secure: isProduction,
        sameSite: 'lax',
        maxAge: 5 * 60 * 1000,
        path: '/',
    });
}

// Single-use: read and immediately clear, success or failure.
function consumeChallenge(req: Request, res: Response): string | null {
    const challenge = req.cookies?.[CHALLENGE_COOKIE];
    res.clearCookie(CHALLENGE_COOKIE, { httpOnly: true, secure: isProduction, sameSite: 'lax', path: '/' });
    return challenge || null;
}

// --- Management (authenticated) ---

router.post('/register/options', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const options = await PasskeyService.getRegistrationOptions(req.user!);
        setChallengeCookie(res, options.challenge);
        res.json(options);
    } catch (error) {
        next(error);
    }
});

router.post('/register/verify', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const challenge = consumeChallenge(req, res);
        if (!challenge) {
            res.status(400).json({ error: 'Challenge expired, try again' });
            return;
        }
        const passkey = await PasskeyService.verifyRegistration(
            req.user!,
            req.body?.response as any,
            req.body?.name || '',
            challenge
        );
        res.status(201).json(passkey);
    } catch (error) {
        next(error);
    }
});

router.get('/', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        res.json(await PasskeyService.listPasskeys(req.user!.id));
    } catch (error) {
        next(error);
    }
});

router.delete('/:id', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        await PasskeyService.deletePasskey(req.user!.id, req.params.id as string);
        res.json({ message: 'Passkey removed' });
    } catch (error) {
        next(error);
    }
});

// --- Login (public, rate-limited) ---

router.post('/login/options', authLimiter, async (_req: Request, res: Response, next: NextFunction) => {
    try {
        const options = await PasskeyService.getLoginOptions();
        setChallengeCookie(res, options.challenge);
        res.json(options);
    } catch (error) {
        next(error);
    }
});

router.post('/login/verify', authLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const challenge = consumeChallenge(req, res);
        if (!challenge) {
            res.status(400).json({ error: 'Challenge expired, try again' });
            return;
        }
        const result = await PasskeyService.verifyLogin(req.body?.response as any, challenge);
        setAuthCookies(res, result.accessToken, result.refreshToken);
        res.json({ user: serializeUser(result.user) });
    } catch (error) {
        next(error);
    }
});

export default router;
