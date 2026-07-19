import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { authenticate, AuthRequest } from '../middleware/auth';
import { PasskeyService } from '../services/passkey.service';
import { authLimiter, serializeUser, setAuthCookies } from './auth.routes';
import { config } from '../config';

const router = Router();
const isProduction = config.nodeEnv === 'production';

const CHALLENGE_COOKIE = 'webauthnChallenge';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

// Cookie value is client-controlled, so it's HMAC-signed to prove the server
// issued it and to enforce the 5-minute expiry server-side (cookie maxAge is
// only advisory — the client can send a stale cookie back at will).
function hmacChallenge(challenge: string, issuedAtMs: number): string {
    return crypto
        .createHmac('sha256', config.jwt.secret)
        .update(`${challenge}.${issuedAtMs}`)
        .digest('hex');
}

// Exported so tests can build valid signed cookies without duplicating the HMAC logic.
export function signChallenge(challenge: string, issuedAt: number = Date.now()): string {
    return `${challenge}.${issuedAt}.${hmacChallenge(challenge, issuedAt)}`;
}

function setChallengeCookie(res: Response, challenge: string) {
    res.cookie(CHALLENGE_COOKIE, signChallenge(challenge), {
        httpOnly: true,
        secure: isProduction,
        sameSite: 'lax',
        maxAge: CHALLENGE_TTL_MS,
        path: '/',
    });
}

// Single-use: read and immediately clear, success or failure.
function consumeChallenge(req: Request, res: Response): string | null {
    const raw = req.cookies?.[CHALLENGE_COOKIE];
    res.clearCookie(CHALLENGE_COOKIE, { httpOnly: true, secure: isProduction, sameSite: 'lax', path: '/' });

    if (typeof raw !== 'string') {
        return null;
    }

    // Challenge strings from @simplewebauthn are base64url, so '.' is a safe
    // separator that can't appear inside the challenge itself.
    const parts = raw.split('.');
    if (parts.length !== 3) {
        return null;
    }
    const [challenge, issuedAtStr, hmacHex] = parts;
    if (!challenge || !issuedAtStr || !hmacHex) {
        return null;
    }

    const issuedAtMs = Number(issuedAtStr);
    if (!Number.isFinite(issuedAtMs)) {
        return null;
    }

    const expected = Buffer.from(hmacChallenge(challenge, issuedAtMs), 'hex');
    const actual = Buffer.from(hmacHex, 'hex');
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
        return null;
    }

    if (Date.now() - issuedAtMs > CHALLENGE_TTL_MS) {
        return null;
    }

    return challenge;
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
