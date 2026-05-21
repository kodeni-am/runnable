import 'reflect-metadata';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import passport from 'passport';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { readFileSync, writeFileSync } from 'fs';
import { AppDataSource } from './config/data-source';
import { config, envPath } from './config';
import { errorHandler } from './middleware/errorHandler';
import { ProcessService } from './services/process.service';
import { User } from './entities/User';
import { Role } from './entities/enums';
import bcrypt from 'bcryptjs';

// Routes
import authRoutes from './routes/auth.routes';
import projectRoutes from './routes/projects.routes';
import fileRoutes from './routes/files.routes';
import githubRoutes from './routes/github.routes';
import domainRoutes from './routes/domains.routes';
import adminRoutes from './routes/admin.routes';
import systemRoutes from './routes/system.routes';

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

    const app = express();
    const httpServer = createServer(app);

    // Socket.IO for real-time updates
    const io = new SocketIOServer(httpServer, {
        cors: {
            origin: process.env.CLIENT_URL || 'http://localhost:5175',
            methods: ['GET', 'POST'],
        },
    });

    ProcessService.setSocketIO(io);

    io.on('connection', (socket) => {
        console.log(`🔌 Client connected: ${socket.id}`);
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

    // GitHub webhook (mounted at root level)
    app.use('/api', githubRoutes);

    // Error handler (must be last)
    app.use(errorHandler);

    // Start server
    httpServer.listen(config.port, () => {
        console.log(`🚀 Runnable API server running on port ${config.port}`);
        console.log(`📡 Environment: ${config.nodeEnv}`);
    });

    // Graceful shutdown
    const shutdown = async () => {
        console.log('\n🛑 Shutting down...');
        io.close();
        await AppDataSource.destroy();
        process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}

bootstrap();
