import dotenv from 'dotenv';
dotenv.config({ path: '../.env' });

export const config = {
    port: parseInt(process.env.PORT || '3001', 10),
    nodeEnv: process.env.NODE_ENV || 'development',

    admin: {
        email: process.env.ADMIN_EMAIL || 'admin@localhost',
        username: process.env.ADMIN_USERNAME || 'admin',
        password: process.env.ADMIN_PASSWORD || 'admin_password_change_me',
    },

    database: {
        host: process.env.DATABASE_HOST || 'localhost',
        port: parseInt(process.env.DATABASE_PORT || '5432', 10),
        name: process.env.DATABASE_NAME || 'runnable',
        user: process.env.DATABASE_USER || 'runnable',
        password: process.env.DATABASE_PASSWORD || 'change_me_in_production',
    },

    jwt: {
        secret: process.env.JWT_SECRET || 'dev-secret-change-me',
        refreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret-change-me',
        accessExpiry: '15m',
        refreshExpiry: '7d',
    },

    hosting: {
        servDir: process.env.SERV_DIR || '/var/runnable/projects',
        baseDomain: process.env.BASE_DOMAIN || 'localhost',
        maxUploadSizeMB: parseInt(process.env.MAX_UPLOAD_SIZE_MB || '512', 10),
    },

    github: {
        clientId: process.env.GITHUB_CLIENT_ID || '',
        clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
        callbackUrl: process.env.GITHUB_CALLBACK_URL || 'http://localhost:3001/api/auth/github/callback',
    },

    google: {
        clientId: process.env.GOOGLE_CLIENT_ID || '',
        clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
        callbackUrl: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3001/api/auth/google/callback',
    },

    caddy: {
        configDir: process.env.CADDY_CONFIG_DIR || '/etc/caddy/sites',
        adminApi: process.env.CADDY_ADMIN_API || 'http://localhost:2019',
    },

    sandbox: {
        enabled: process.env.SANDBOX_ENABLED === 'true',
        userPrefix: process.env.SANDBOX_USER_PREFIX || 'runnable-',
    },
};

// --- Production safety checks ---
if (config.nodeEnv === 'production') {
    const errors: string[] = [];
    if (!process.env.JWT_SECRET) errors.push('JWT_SECRET must be set in production');
    if (!process.env.JWT_REFRESH_SECRET) errors.push('JWT_REFRESH_SECRET must be set in production');
    if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD === 'admin_password_change_me') {
        errors.push('ADMIN_PASSWORD must be changed in production');
    }
    if (!process.env.DATABASE_PASSWORD || process.env.DATABASE_PASSWORD === 'change_me_in_production') {
        errors.push('DATABASE_PASSWORD must be changed in production');
    }
    if (errors.length > 0) {
        console.error('❌ FATAL: Missing required production configuration:');
        errors.forEach(e => console.error(`   • ${e}`));
        process.exit(1);
    }
}
