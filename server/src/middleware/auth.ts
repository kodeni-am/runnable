import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { AppDataSource } from '../config/data-source';
import { User as UserEntity, Role } from '../entities';

declare global {
    namespace Express {
        interface User extends UserEntity { }
    }
}

export type AuthRequest<P = import('express-serve-static-core').ParamsDictionary> = Request<P>;

export interface JwtPayload {
    userId: string;
    role: Role;
}

export const authenticate = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            res.status(401).json({ error: 'No token provided' });
            return;
        }

        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, config.jwt.secret) as JwtPayload;

        const userRepo = AppDataSource.getRepository(UserEntity);
        const user = await userRepo.findOne({ where: { id: decoded.userId } });

        if (!user) {
            res.status(401).json({ error: 'User not found' });
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
