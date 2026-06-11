import { Router, Response, NextFunction } from 'express';
import { authenticate, requireApproval, AuthRequest } from '../middleware/auth';
import { APP_TEMPLATES } from '../templates/catalog';

const router = Router();

router.use(authenticate, requireApproval);

// List available one-click templates (compose content omitted — it's written
// server-side at provisioning time and editable in the file browser after)
router.get('/', (_req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        res.json(APP_TEMPLATES.map(({ composeYaml, ...t }) => t));
    } catch (error) {
        next(error);
    }
});

export default router;
