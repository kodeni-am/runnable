import { Router, Response, NextFunction } from 'express';
import { AppDataSource } from '../config/data-source';
import { Project, CustomDomain } from '../entities';
import { ProjectPermission } from '../entities/enums';
import { authenticate, requireApproval, requireProjectAccess, AuthRequest } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { DomainService } from '../services/domain.service';

const router = Router();

// All internal routes require authentication and admin approval
router.use(authenticate, requireApproval);

// List custom domains for a project
router.get('/:id/domains', requireProjectAccess(), async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const project = (req as any).project as Project;
        const domainRepo = AppDataSource.getRepository(CustomDomain);
        const domains = await domainRepo.find({ where: { projectId: project.id } });
        res.json(domains);
    } catch (error) {
        next(error);
    }
});

// Add custom domain
router.post('/:id/domains', requireProjectAccess(ProjectPermission.CAN_EDIT_DOMAINS), async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const project = (req as any).project as Project;

        const { domain, redirectTarget } = req.body;
        if (!domain) throw new AppError('Domain is required', 400);

        const result = await DomainService.addDomain(project.id, domain);

        // If they provided a redirect target right away, set it
        if (redirectTarget) {
            await DomainService.setRedirectTarget(result.domain.id, redirectTarget);
            result.domain.redirectTarget = redirectTarget.trim().toLowerCase();
        }

        res.status(201).json(result);
    } catch (error) {
        next(error);
    }
});

// Update redirect target
router.put('/:id/domains/:domainId/redirect', requireProjectAccess(ProjectPermission.CAN_EDIT_DOMAINS), async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const { redirectTarget } = req.body;

        // Setting it to null/empty string clears the redirect
        const target = redirectTarget ? String(redirectTarget).trim() : null;

        const updatedDomain = await DomainService.setRedirectTarget(req.params.domainId as string, target);

        res.json(updatedDomain);
    } catch (error) {
        next(error);
    }
});

// Verify domain DNS
router.post('/:id/domains/:domainId/verify', requireProjectAccess(ProjectPermission.CAN_EDIT_DOMAINS), async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const verified = await DomainService.verifyDomain(req.params.domainId as string);
        res.json({ verified });
    } catch (error) {
        next(error);
    }
});

// Remove custom domain
router.delete('/:id/domains/:domainId', requireProjectAccess(ProjectPermission.CAN_EDIT_DOMAINS), async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        await DomainService.removeDomain(req.params.domainId as string);
        res.json({ message: 'Domain removed' });
    } catch (error) {
        next(error);
    }
});

export default router;
