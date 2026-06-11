import 'reflect-metadata';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import passport from 'passport';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { readFileSync, writeFileSync } from 'fs';
import jwt from 'jsonwebtoken';
import { In } from 'typeorm';
import { AppDataSource } from './config/data-source';
import { config, envPath } from './config';
import { errorHandler } from './middleware/errorHandler';
import { ProcessService } from './services/process.service';
import { HealthMonitorService } from './services/healthMonitor.service';
import { SandboxService } from './services/sandbox.service';
import { User } from './entities/User';
import { Project } from './entities/Project';
import { ProjectCollaborator } from './entities/ProjectCollaborator';
import { Role, ServiceStatus } from './entities/enums';
import type { JwtPayload } from './middleware/auth';
import bcrypt from 'bcryptjs';

// Routes
import authRoutes from './routes/auth.routes';
import projectRoutes from './routes/projects.routes';
import fileRoutes from './routes/files.routes';
import githubRoutes from './routes/github.routes';
import domainRoutes from './routes/domains.routes';
import adminRoutes from './routes/admin.routes';
import systemRoutes from './routes/system.routes';
import templateRoutes from './routes/templates.routes';
import webhookRoutes from './routes/webhooks.routes';
import internalRoutes from './routes/internal.routes';

/**
 * Flip ADMIN_PASSWORD_RESET back to false in .env so a password reset only
 * happens for the single boot it was requested on, never on every restart.
 */
function clearPasswordResetFlag(): void {
    try {
        const raw = readFileSync(envPath, 'utf8');
        if (!/^ADMIN_PASSWORD_RESET=/m.test(raw)) {
            console.warn(
                '⚠️  ADMIN_PASSWORD_RESET is set outside .env — remove it manually to avoid resetting the password on the next restart.'
            );
            return;
        }
        writeFileSync(envPath, raw.replace(/^ADMIN_PASSWORD_RESET=.*$/m, 'ADMIN_PASSWORD_RESET=false'));
        console.log('✅ ADMIN_PASSWORD_RESET reset to false in .env');
    } catch (err) {
        console.warn(`⚠️  Could not auto-clear ADMIN_PASSWORD_RESET in .env: ${(err as Error).message}`);
        console.warn('   Remove ADMIN_PASSWORD_RESET from .env manually to avoid resetting the password again.');
    }
}

async function bootstrap() {
    // Initialize database
    try {
        await AppDataSource.initialize();
        console.log('✅ Database connected');

        // Seed default admin on first run. The .env password is only used to
        // create the account (or to recover one that has no password set) —
        // it must never overwrite a password the admin changed in the app.
        const userRepo = AppDataSource.getRepository(User);
        const existingAdmin = await userRepo.findOne({ where: { role: Role.ADMIN } });
        if (!existingAdmin) {
            const adminUser = userRepo.create({
                email: config.admin.email,
                username: config.admin.username,
                passwordHash: await bcrypt.hash(config.admin.password, 12),
                role: Role.ADMIN,
                isApproved: true,
            });
            await userRepo.save(adminUser);
            console.log(`✅ Default admin account created: ${config.admin.email}`);
        } else if (!existingAdmin.passwordHash) {
            // Admin exists but has no password (e.g. OAuth-only) — initialize from .env
            existingAdmin.passwordHash = await bcrypt.hash(config.admin.password, 12);
            await userRepo.save(existingAdmin);
            console.log(`✅ Admin password initialized from .env: ${existingAdmin.email}`);
        } else if (config.admin.passwordReset) {
            // Explicit one-shot reset opt-in via ADMIN_PASSWORD_RESET=true
            existingAdmin.passwordHash = await bcrypt.hash(config.admin.password, 12);
            await userRepo.save(existingAdmin);
            console.warn(`⚠️  Admin password reset from .env (ADMIN_PASSWORD_RESET): ${existingAdmin.email}`);
            clearPasswordResetFlag();
        } else {
            console.log(`✅ Admin account present: ${existingAdmin.email}`);
        }
    } catch (error) {
        console.error('❌ Database connection failed:', error);
        process.exit(1);
    }

    // Reconcile state from a previous crash: a project stuck in BUILDING or
    // DEPLOYING has no build actually running anymore. RUNNING projects are
    // left alone — their containers survive restarts (--restart unless-stopped)
    // and the health monitor flags any that died.
    try {
        const projectRepo = AppDataSource.getRepository(Project);
        const stuck = await projectRepo.update(
            { status: In([ServiceStatus.BUILDING, ServiceStatus.DEPLOYING]) },
            { status: ServiceStatus.ERROR },
        );
        if (stuck.affected) {
            console.warn(`⚠️  Reset ${stuck.affected} project(s) stuck in BUILDING/DEPLOYING from a previous run`);
        }
    } catch (error) {
        console.error('Failed to reconcile project statuses:', error);
    }

    const app = express();
    // Behind the Caddy reverse proxy — without this, req.ip is the proxy's
    // address and every rate limiter collapses into one global bucket.
    app.set('trust proxy', 1);
    const httpServer = createServer(app);

    // Socket.IO for real-time updates
    const io = new SocketIOServer(httpServer, {
        cors: {
            origin: process.env.CLIENT_URL || 'http://localhost:5175',
            methods: ['GET', 'POST'],
        },
    });

    ProcessService.setSocketIO(io);

    // Authenticate the socket handshake with the same JWT cookie the REST API
    // uses — without this, anyone who can reach the port receives every
    // tenant's project status events.
    io.use((socket, next) => {
        try {
            const raw = socket.handshake.headers.cookie || '';
            const match = raw.match(/(?:^|;\s*)accessToken=([^;]+)/);
            const token = match ? decodeURIComponent(match[1]) : null;
            if (!token) return next(new Error('unauthorized'));
            const decoded = jwt.verify(token, config.jwt.secret) as JwtPayload;
            socket.data.userId = decoded.userId;
            socket.data.tokenVersion = decoded.tokenVersion ?? 0;
            next();
        } catch {
            next(new Error('unauthorized'));
        }
    });

    io.on('connection', (socket) => {
        console.log(`🔌 Client connected: ${socket.id}`);

        // Status events are scoped to project rooms; clients subscribe to the
        // projects they can access.
        socket.on('subscribe', async (projectId: unknown) => {
            try {
                if (typeof projectId !== 'string') return;
                const project = await AppDataSource.getRepository(Project).findOne({ where: { id: projectId } });
                if (!project) return;

                // Check role and token version from the DB, not the token —
                // a demoted admin or a revoked session must not keep
                // subscribe access for the token's lifetime
                const user = await AppDataSource.getRepository(User).findOne({ where: { id: socket.data.userId } });
                if (!user || (user.tokenVersion ?? 0) !== socket.data.tokenVersion) return;

                const isOwner = project.userId === user.id;
                const isAdmin = user.role === Role.ADMIN;
                let allowed = isOwner || isAdmin;
                if (!allowed) {
                    const collab = await AppDataSource.getRepository(ProjectCollaborator).findOne({
                        where: { userId: socket.data.userId, projectId },
                    });
                    allowed = !!collab;
                }
                if (allowed) socket.join(`project:${projectId}`);
            } catch {
                // Subscription failures are non-fatal — the client just gets no live updates
            }
        });

        socket.on('unsubscribe', (projectId: unknown) => {
            if (typeof projectId === 'string') socket.leave(`project:${projectId}`);
        });

        socket.on('disconnect', () => {
            console.log(`🔌 Client disconnected: ${socket.id}`);
        });
    });

    // Middleware
    app.use(helmet());
    app.use(cors({
        origin: process.env.CLIENT_URL || 'http://localhost:5175',
        credentials: true,
    }));
    app.use(express.json({
        limit: '3mb',
        verify: (req: any, _res, buf) => {
            req.rawBody = buf;
        },
    }));
    app.use(express.urlencoded({ extended: true }));
    app.use(cookieParser());
    app.use(passport.initialize());

    // Health check
    app.get('/api/health', (_req, res) => {
        res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    // API Routes
    app.use('/api/auth', authRoutes);
    app.use('/api/projects', projectRoutes);
    app.use('/api/projects', fileRoutes);
    app.use('/api/projects', githubRoutes);
    app.use('/api/projects', domainRoutes);
    app.use('/api/admin', adminRoutes);
    app.use('/api/system', systemRoutes);
    app.use('/api/templates', templateRoutes);
    app.use('/api/webhooks', webhookRoutes);
    app.use('/api/internal', internalRoutes);

    // Error handler (must be last)
    app.use(errorHandler);

    // Start server. In production bind to loopback only: the API sits behind
    // the reverse proxy, and `trust proxy` makes X-Forwarded-For
    // authoritative — a direct connection to the port could spoof it (and
    // with it, the rate-limit buckets). HOST overrides for containers.
    const host = process.env.HOST || (config.nodeEnv === 'production' ? '127.0.0.1' : '0.0.0.0');
    httpServer.listen(config.port, host, () => {
        console.log(`🚀 Runnable API server running on ${host}:${config.port}`);
        console.log(`📡 Environment: ${config.nodeEnv}`);
    });

    // Remediate any pre-existing sandbox users still in the docker group
    SandboxService.reconcileDockerGroup().catch(() => { });

    // Watch running app containers; notifies + optionally restarts on crash
    HealthMonitorService.start();

    // Graceful shutdown
    const shutdown = async () => {
        console.log('\n🛑 Shutting down...');
        HealthMonitorService.stop();
        io.close();
        // Let in-flight HTTP requests finish before tearing down the DB
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
        await AppDataSource.destroy();
        process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}

bootstrap().catch((error) => {
    console.error('❌ Fatal startup error:', error);
    process.exit(1);
});
