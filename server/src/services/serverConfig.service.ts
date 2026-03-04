import fs from 'fs/promises';
import path from 'path';
import { config } from '../config';
import { ServerType } from '../entities';

interface ServerConfigOptions {
    subdomain: string;
    directoryPath: string;
    port: number;
    serverType: ServerType;
    customDomains?: { domain: string, redirectTarget: string | null }[];
}

export class ServerConfigService {
    // Strict domain validation to prevent config injection
    private static sanitizeDomain(domain: string): string {
        if (!domain) return '';
        // Only allow valid domain characters: alphanumeric, dots, hyphens
        const sanitized = domain.trim().toLowerCase();
        if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(sanitized)) {
            throw new Error(`Invalid domain: ${domain}`);
        }
        // Reject domains containing Caddy/Nginx directive characters
        if (/[{};\n\r"'`\\]/.test(sanitized)) {
            throw new Error(`Domain contains invalid characters: ${domain}`);
        }
        return sanitized;
    }

    static async generateConfig(options: ServerConfigOptions): Promise<string> {
        // Sanitize all domains before generating config
        options.subdomain = ServerConfigService.sanitizeDomain(options.subdomain);
        if (options.customDomains) {
            options.customDomains = options.customDomains.map(d => ({
                domain: ServerConfigService.sanitizeDomain(d.domain),
                redirectTarget: d.redirectTarget ? ServerConfigService.sanitizeDomain(d.redirectTarget) : null
            }));
        }

        switch (options.serverType) {
            case ServerType.CADDY:
            case ServerType.STATIC:
            case ServerType.APP:
                return ServerConfigService.generateCaddyConfig(options);
            case ServerType.NGINX:
                return ServerConfigService.generateNginxConfig(options);
            case ServerType.APACHE:
                return ServerConfigService.generateApacheConfig(options);
            default:
                throw new Error(`Unsupported server type: ${options.serverType}`);
        }
    }

    static generateCaddyConfig(options: ServerConfigOptions): string {
        const redirectedDomains = options.customDomains?.filter(d => Boolean(d.redirectTarget)) || [];
        const normalCustomDomains = options.customDomains?.filter(d => !d.redirectTarget)?.map(d => d.domain) || [];

        const mainDomains = [
            `${options.subdomain}.${config.hosting.baseDomain}`,
            ...normalCustomDomains,
        ];

        let configStr = '';

        // Add redirect blocks for each domain that has a redirectTarget
        for (const rd of redirectedDomains) {
            configStr += `${rd.domain} {\n  redir https://${rd.redirectTarget}{uri}\n}\n\n`;
        }

        const domainList = mainDomains.join(', ');

        if (options.serverType === ServerType.STATIC) {
            configStr += `${domainList} {
  root * ${options.directoryPath}
  file_server browse
  encode gzip zstd
  log {
    output file /var/log/caddy/${options.subdomain}.log
  }
}
`;
        } else {
            configStr += `${domainList} {
  reverse_proxy localhost:${options.port}
  encode gzip zstd
  log {
    output file /var/log/caddy/${options.subdomain}.log
  }
}
`;
        }

        return configStr;
    }

    static generateNginxConfig(options: ServerConfigOptions): string {
        const serverNames = [
            `${options.subdomain}.${config.hosting.baseDomain}`,
            ...(options.customDomains || []),
        ].join(' ');

        return `server {
    listen 80;
    server_name ${serverNames};

    access_log ./storage/logs/${options.subdomain}-access.log;
    error_log ./storage/logs/${options.subdomain}-error.log;

    location / {
        proxy_pass http://127.0.0.1:${options.port};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
`;
    }

    static generateApacheConfig(options: ServerConfigOptions): string {
        const serverName = `${options.subdomain}.${config.hosting.baseDomain}`;
        const aliases = (options.customDomains || []).map(d => `    ServerAlias ${d}`).join('\n');

        return `<VirtualHost *:80>
    ServerName ${serverName}
${aliases}

    ProxyPreserveHost On
    ProxyPass / http://127.0.0.1:${options.port}/
    ProxyPassReverse / http://127.0.0.1:${options.port}/

    ErrorLog ./storage/logs/${options.subdomain}-error.log
    CustomLog ./storage/logs/${options.subdomain}-access.log combined
</VirtualHost>
`;
    }

    static async writeConfig(subdomain: string, configContent: string, serverType: ServerType): Promise<string> {
        const configDir = config.caddy.configDir;
        await fs.mkdir(configDir, { recursive: true });

        let ext = '.conf';
        if (serverType === ServerType.CADDY || serverType === ServerType.STATIC || serverType === ServerType.APP) {
            ext = '.caddyfile';
        }

        const configPath = path.join(configDir, `${subdomain}${ext}`);
        await fs.writeFile(configPath, configContent, 'utf-8');
        return configPath;
    }

    static async removeConfig(configPath: string): Promise<void> {
        try {
            await fs.unlink(configPath);
        } catch {
            // Config may already be removed
        }
    }

    static async reloadCaddy(): Promise<void> {
        try {
            const { execFile } = await import('child_process');
            const { promisify } = await import('util');
            const execFileAsync = promisify(execFile);
            await execFileAsync('sudo', ['-n', 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile']);
            console.log('✅ Caddy reloaded successfully');
        } catch (error) {
            console.error('Failed to reload Caddy:', error);
        }
    }
}
