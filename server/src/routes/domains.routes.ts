import { Router, Response, NextFunction } from 'express';
import { AppDataSource } from '../config/data-source';
import { Project, CustomDomain } from '../entities';
import { authenticate, requireApproval, AuthRequest } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { DomainService } from '../services/domain.service';

const router = Router();

// All internal routes require authentication and admin approval
router.use(authenticate, requireApproval);

// List custom domains for a project
router.get('/:id/domains', async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const projectRepo = AppDataSource.getRepository(Project);
        const project = await projectRepo.findOne({
            where: { id: req.params.id as string, userId: req.user!.id },
        });
        if (!project) throw new AppError('Project not found', 404);

        const domainRepo = AppDataSource.getRepository(CustomDomain);
        const domains = await domainRepo.find({ where: { projectId: project.id } });
        res.json(domains);
    } catch (error) {
        next(error);
    }
});

// Add custom domain
router.post('/:id/domains', async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const projectRepo = AppDataSource.getRepository(Project);
        const project = await projectRepo.findOne({
            where: { id: req.params.id as string, userId: req.user!.id },
        });
        if (!project) throw new AppError('Project not found', 404);

        const { domain } = req.body;
        if (!domain) throw new AppError('Domain is required', 400);

        const result = await DomainService.addDomain(project.id, domain);
        res.status(201).json(result);
    } catch (error) {
        next(error);
    }
});

// Verify domain DNS
router.post('/:id/domains/:domainId/verify', async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const verified = await DomainService.verifyDomain(req.params.domainId as string);
        res.json({ verified });
    } catch (error) {
        next(error);
    }
});

// Remove custom domain
router.delete('/:id/domains/:domainId', async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        await DomainService.removeDomain(req.params.domainId as string);
        res.json({ message: 'Domain removed' });
    } catch (error) {
        next(error);
    }
});

export default router;
