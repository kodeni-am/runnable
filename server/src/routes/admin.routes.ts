import { Router, Response, NextFunction } from 'express';
import { AppDataSource } from '../config/data-source';
import { User, Role } from '../entities';
import { sanitizeUserPermissions } from '../entities/User';
import { authenticate, requireRole } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';

const router = Router();

// All admin routes require authentication and ADMIN role
router.use(authenticate, requireRole(Role.ADMIN));

// List users
router.get('/users', async (req, res, next: NextFunction) => {
    try {
        const userRepo = AppDataSource.getRepository(User);
        const users = await userRepo.find({
            order: { createdAt: 'DESC' },
            select: ['id', 'email', 'username', 'role', 'isApproved', 'createdAt', 'githubId', 'googleId', 'permissions'],
        });
        res.json(users);
    } catch (error) {
        next(error);
    }
});

// Approve user
router.put('/users/:id/approve', async (req, res, next: NextFunction) => {
    try {
        const userRepo = AppDataSource.getRepository(User);
        const user = await userRepo.findOne({ where: { id: req.params.id as string } });

        if (!user) {
            throw new AppError('User not found', 404);
        }

        user.isApproved = true;
        await userRepo.save(user);

        res.json({ message: 'User approved' });
    } catch (error) {
        next(error);
    }
});

// Update user permissions (Tier 1 global permissions)
router.put('/users/:id/permissions', async (req, res, next: NextFunction) => {
    try {
        const userRepo = AppDataSource.getRepository(User);
        const user = await userRepo.findOne({ where: { id: req.params.id as string } });

        if (!user) {
            throw new AppError('User not found', 404);
        }

        const { permissions } = req.body;
        if (!permissions) {
            throw new AppError('Permissions object is required', 400);
        }

        user.permissions = sanitizeUserPermissions(permissions);
        await userRepo.save(user);

        res.json({ message: 'Permissions updated', permissions: user.permissions });
    } catch (error) {
        next(error);
    }
});

// Delete user
router.delete('/users/:id', async (req, res, next: NextFunction) => {
    try {
        const userRepo = AppDataSource.getRepository(User);
        const user = await userRepo.findOne({ where: { id: req.params.id as string } });

        if (!user) {
            throw new AppError('User not found', 404);
        }

        if (user.role === Role.ADMIN) {
            throw new AppError('Cannot delete another admin', 403);
        }

        // Ideally we should also delete their projects and running instances, but cascading should handle DB rows.
        await userRepo.remove(user);

        res.json({ message: 'User deleted' });
    } catch (error) {
        next(error);
    }
});

export default router;
