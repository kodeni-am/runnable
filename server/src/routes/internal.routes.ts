import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { TlsCheckService } from '../services/tlsCheck.service';

const router = Router();

// Called server-side by Caddy's on_demand_tls `ask`. Unauthenticated by
// necessity, but rate-limited so it can't be used to probe hostnames or DoS.
const tlsCheckLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
});

// Caddy issues a cert only if this returns 2xx.
router.get('/tls-check', tlsCheckLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const domain = (req.query.domain as string) || '';
        const ok = await TlsCheckService.isLivePreviewHostname(domain);
        if (ok) {
            res.status(200).send('ok');
        } else {
            res.status(404).send('unknown host');
        }
    } catch (error) {
        next(error);
    }
});

export default router;
