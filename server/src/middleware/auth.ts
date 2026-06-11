import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { AppDataSource } from '../config/data-source';
import { User as UserEntity, Role, ProjectCollaborator, Project } from '../entities';
import { ProjectPermission } from '../entities/enums';
import type { ProjectPermissions } from '../entities/ProjectCollaborator';

declare global {
    namespace Express {
        interface User extends UserEntity { }
    }
}

export type AuthRequest<P = import('express-serve-static-core').ParamsDictionary> = Request<P>;

export interface JwtPayload {
    userId: string;
    role: Role;
    /** Must match the user's current tokenVersion; bumped to revoke all tokens */
    tokenVersion?: number;
}

export const authenticate = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
        // Read token from HTTP-only cookie first, fall back to Authorization header
        let token = req.cookies?.accessToken;
        if (!token) {
            const authHeader = req.headers.authorization;
            if (authHeader && authHeader.startsWith('Bearer ')) {
                token = authHeader.split(' ')[1];
            }
        }

        if (!token) {
            res.status(401).json({ error: 'No token provided' });
            return;
        }

        const decoded = jwt.verify(token, config.jwt.secret) as JwtPayload;

        const userRepo = AppDataSource.getRepository(UserEntity);
        const user = await userRepo.findOne({ where: { id: decoded.userId } });

        if (!user) {
            res.status(401).json({ error: 'User not found' });
            return;
        }

        // Tokens issued before a password/email change carry a stale version
        if ((decoded.tokenVersion ?? 0) !== (user.tokenVersion ?? 0)) {
            res.status(401).json({ error: 'Session invalidated, please log in again' });
            return;
        }

        req.user = user;
        next();
    } catch (error) {
        res.status(401).json({ error: 'Invalid token' });
    }
};

export const requireApproval = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
        res.status(401).json({ error: 'Not authenticated' });
        return;
    }
    if (!req.user.isApproved && req.user.role !== Role.ADMIN) {
        res.status(403).json({ error: 'Account pending admin approval' });
        return;
    }
    next();
};

export const requireRole = (...roles: Role[]) => {
    return (req: AuthRequest, res: Response, next: NextFunction): void => {
        if (!req.user) {
            res.status(401).json({ error: 'Not authenticated' });
            return;
        }
        if (!roles.includes(req.user.role)) {
            res.status(403).json({ error: 'Insufficient permissions' });
            return;
        }
        next();
    };
};

/**
 * Middleware that checks if the user has the required project-level permissions.
 * The project ID is read from req.params.id.
 *
 * Access is granted if:
 * 1. User is the project owner → full access
 * 2. User is an admin → full access
 * 3. User is a collaborator with the required permission flags
 *
 * If no permissions are specified, any collaborator (or owner/admin) can access.
 * The resolved project is attached to req.project for downstream use.
 */
export const requireProjectAccess = (...permissions: ProjectPermission[]) => {
    return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
        try {
            if (!req.user) {
                res.status(401).json({ error: 'Not authenticated' });
                return;
            }

            const projectId = req.params.id as string;
            if (!projectId) {
                res.status(400).json({ error: 'Project ID is required' });
                return;
            }

            // Reject malformed ids before the query — a non-UUID makes the
            // Postgres uuid cast throw, surfacing as a 500 instead of a 404.
            if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) {
                res.status(404).json({ error: 'Project not found' });
                return;
            }

            const projectRepo = AppDataSource.getRepository(Project);
            const project = await projectRepo.findOne({
                where: { id: projectId },
                relations: ['customDomains', 'githubRepo'],
            });

            if (!project) {
                res.status(404).json({ error: 'Project not found' });
                return;
            }

            // Attach project for downstream handlers
            (req as any).project = project;

            // Owner has full access
            if (project.userId === req.user.id) {
                next();
                return;
            }

            // Admin has full access
            if (req.user.role === Role.ADMIN) {
                next();
                return;
            }

            // Check collaborator permissions
            const collabRepo = AppDataSource.getRepository(ProjectCollaborator);
            const collab = await collabRepo.findOne({
                where: { userId: req.user.id, projectId },
            });

            if (!collab) {
                res.status(403).json({ error: 'You do not have access to this project' });
                return;
            }

            // If specific permissions are required, check them
            if (permissions.length > 0) {
                const collabPerms = collab.permissions as ProjectPermissions;
                const missingPerms = permissions.filter(p => !collabPerms[p]);
                if (missingPerms.length > 0) {
                    res.status(403).json({ error: `Missing project permission(s): ${missingPerms.join(', ')}` });
                    return;
                }
            }

            next();
        } catch (error) {
            next(error);
        }
    };
};
