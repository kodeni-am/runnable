import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

// Absolute path to the .env file, resolved once so it can be both loaded
// and (when ADMIN_PASSWORD_RESET is used) rewritten by the server.
// Resolved relative to this file (server/{src,dist}/config → repo root), not
// process.cwd() — under systemd/docker the cwd is not the server directory.
// ENV_FILE overrides for non-standard layouts.
export const envPath = process.env.ENV_FILE || path.resolve(__dirname, '../../../.env');
dotenv.config({ path: envPath });

export const config = {
    port: parseInt(process.env.PORT || '3001', 10),
    nodeEnv: process.env.NODE_ENV || 'development',

    admin: {
        email: process.env.ADMIN_EMAIL || 'admin@localhost',
        username: process.env.ADMIN_USERNAME || 'admin',
        password: process.env.ADMIN_PASSWORD || 'admin_password_change_me',
        // One-shot opt-in to reset the admin password from .env on next boot.
        passwordReset: process.env.ADMIN_PASSWORD_RESET === 'true',
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
        apiBaseUrl: process.env.API_BASE_URL || `https://api.${process.env.BASE_DOMAIN || 'localhost'}`,
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

// Environment variables that belong to Runnable itself — its configuration and
// secrets. These must NEVER be inherited by the user build/compose subprocesses
// SandboxService spawns: they include secrets (JWT/DB/OAuth), and PORT in
// particular collides with the API's own listen port when a user compose file
// interpolates `${PORT}` (the deploy then tries to bind the API's port and
// fails with "address already in use"). The user's own env reaches their
// container through a separate channel (project env vars → `.runnable.env` /
// docker `-e`), never by leaking ours. See SandboxService.childEnv.
const STATIC_RUNNABLE_ENV_KEYS = [
    'PORT', 'ENV_FILE',
    'ADMIN_EMAIL', 'ADMIN_USERNAME', 'ADMIN_PASSWORD', 'ADMIN_PASSWORD_RESET',
    'DATABASE_HOST', 'DATABASE_PORT', 'DATABASE_NAME', 'DATABASE_USER', 'DATABASE_PASSWORD',
    'JWT_SECRET', 'JWT_REFRESH_SECRET',
    'SERV_DIR', 'BASE_DOMAIN', 'API_BASE_URL', 'MAX_UPLOAD_SIZE_MB', 'CLIENT_URL',
    'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'GITHUB_CALLBACK_URL',
    'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_CALLBACK_URL',
    'CADDY_CONFIG_DIR', 'CADDY_ADMIN_API',
    'SANDBOX_ENABLED', 'SANDBOX_USER_PREFIX',
];

// Also strip every key actually present in our .env file — that catches any
// operator-added secret/config we don't know about statically. Best-effort:
// a missing/unreadable file just means the static list applies.
function readEnvFileKeys(): string[] {
    try {
        return Object.keys(dotenv.parse(fs.readFileSync(envPath)));
    } catch {
        return [];
    }
}

export const RUNNABLE_OWNED_ENV_KEYS = new Set<string>([...STATIC_RUNNABLE_ENV_KEYS, ...readEnvFileKeys()]);

// --- Production safety checks ---
if (config.nodeEnv === 'production') {
    const errors: string[] = [];
    // Reject the publicly-known placeholder values from .env.example, not just
    // absence — a copied example file must never pass with forgeable tokens.
    const JWT_PLACEHOLDERS = ['change_this_to_a_random_secret_key', 'change_this_to_another_random_secret_key', 'dev-secret-change-me', 'dev-refresh-secret-change-me'];
    if (!process.env.JWT_SECRET || JWT_PLACEHOLDERS.includes(process.env.JWT_SECRET) || process.env.JWT_SECRET.length < 16) {
        errors.push('JWT_SECRET must be set to a strong random value in production');
    }
    if (!process.env.JWT_REFRESH_SECRET || JWT_PLACEHOLDERS.includes(process.env.JWT_REFRESH_SECRET) || process.env.JWT_REFRESH_SECRET.length < 16) {
        errors.push('JWT_REFRESH_SECRET must be set to a strong random value in production');
    }
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
