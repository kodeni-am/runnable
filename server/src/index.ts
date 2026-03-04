import 'reflect-metadata';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import passport from 'passport';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { AppDataSource } from './config/data-source';
import { config } from './config';
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

async function bootstrap() {
    // Initialize database
    try {
        await AppDataSource.initialize();
        console.log('✅ Database connected');

        // Seed or update default admin
        const userRepo = AppDataSource.getRepository(User);
        const existingAdmin = await userRepo.findOne({ where: { role: Role.ADMIN } });
        const passwordHash = await bcrypt.hash(config.admin.password, 12);
        if (!existingAdmin) {
            const adminUser = userRepo.create({
                email: config.admin.email,
                username: config.admin.username,
                passwordHash,
                role: Role.ADMIN,
                isApproved: true,
            });
            await userRepo.save(adminUser);
            console.log(`✅ Default admin account created: ${config.admin.email}`);
        } else {
            // Sync admin credentials with .env on re-deploy
            existingAdmin.email = config.admin.email;
            existingAdmin.username = config.admin.username;
            existingAdmin.passwordHash = passwordHash;
            await userRepo.save(existingAdmin);
            console.log(`✅ Admin account synced: ${config.admin.email}`);
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
    app.use(express.json({ limit: '3mb' }));
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
