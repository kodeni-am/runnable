import fs from 'fs/promises';
import path from 'path';
import { config } from '../config';
import { ServerType } from '../entities';

interface ServerConfigOptions {
    subdomain: string;
    directoryPath: string;
    port: number;
    serverType: ServerType;
    customDomains?: string[];
}

export class ServerConfigService {
    static async generateConfig(options: ServerConfigOptions): Promise<string> {
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
        const domains = [
            `${options.subdomain}.${config.hosting.baseDomain}`,
            ...(options.customDomains || []),
        ];

        const domainList = domains.join(', ');

        if (options.serverType === ServerType.STATIC) {
            return `${domainList} {
  root * ${options.directoryPath}
  file_server browse
  encode gzip zstd
  log {
    output file ./storage/logs/${options.subdomain}.log
  }
}
`;
        }

        return `${domainList} {
  reverse_proxy localhost:${options.port}
  encode gzip zstd
  log {
    output file ./storage/logs/${options.subdomain}.log
  }
}
`;
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
            const response = await fetch(`${config.caddy.adminApi}/load`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            });
            if (!response.ok) {
                console.error('Failed to reload Caddy:', await response.text());
            }
        } catch (error) {
            console.error('Failed to reload Caddy:', error);
        }
    }
}
