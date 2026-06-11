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
    /** Overrides config.hosting.baseDomain (preview environments). */
    baseDomain?: string;
    /** Emit `tls { on_demand }` so Caddy fetches the cert lazily (previews). */
    onDemandTls?: boolean;
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

        if (options.baseDomain) {
            options.baseDomain = ServerConfigService.sanitizeDomain(options.baseDomain);
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
        const baseDomain = options.baseDomain || config.hosting.baseDomain;
        const redirectedDomains = options.customDomains?.filter(d => Boolean(d.redirectTarget)) || [];
        const normalCustomDomains = options.customDomains?.filter(d => !d.redirectTarget)?.map(d => d.domain) || [];

        const mainDomains = [
            `${options.subdomain}.${baseDomain}`,
            ...normalCustomDomains,
        ];

        let configStr = '';

        // Add redirect blocks for each domain that has a redirectTarget
        for (const rd of redirectedDomains) {
            configStr += `${rd.domain} {\n  redir https://${rd.redirectTarget}{uri}\n}\n\n`;
        }

        const domainList = mainDomains.join(', ');
        // Preview hostnames use on-demand TLS: Caddy fetches the cert on first
        // request (gated by the tls-check ask endpoint) instead of up front.
        const tlsBlock = options.onDemandTls ? '  tls {\n    on_demand\n  }\n' : '';

        if (options.serverType === ServerType.STATIC) {
            configStr += `${domainList} {
${tlsBlock}  root * ${options.directoryPath}
  file_server
  encode gzip zstd
  log {
    output file /var/log/caddy/${options.subdomain}.log
  }
}
`;
        } else {
            configStr += `${domainList} {
${tlsBlock}  reverse_proxy localhost:${options.port}
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
        const redirectedDomains = options.customDomains?.filter(d => Boolean(d.redirectTarget)) || [];
        const normalCustomDomains = options.customDomains?.filter(d => !d.redirectTarget)?.map(d => d.domain) || [];

        const serverNames = [
            `${options.subdomain}.${config.hosting.baseDomain}`,
            ...normalCustomDomains,
        ].join(' ');

        const redirectBlocks = redirectedDomains.map(rd => `server {
    listen 80;
    server_name ${rd.domain};
    return 301 https://${rd.redirectTarget}$request_uri;
}

`).join('');

        return `${redirectBlocks}server {
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
        const redirectedDomains = options.customDomains?.filter(d => Boolean(d.redirectTarget)) || [];
        const aliases = (options.customDomains || [])
            .filter(d => !d.redirectTarget)
            .map(d => `    ServerAlias ${d.domain}`)
            .join('\n');

        const redirectBlocks = redirectedDomains.map(rd => `<VirtualHost *:80>
    ServerName ${rd.domain}
    Redirect permanent / https://${rd.redirectTarget}/
</VirtualHost>

`).join('');

        return `${redirectBlocks}<VirtualHost *:80>
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

    /**
     * Reload the master reverse proxy. Lenient by default (failures are
     * logged and swallowed — most callers can't do anything useful with
     * them). Pass { strict: true } to propagate failure: the zero-downtime
     * cutover must know whether the new config was actually activated so it
     * can roll the config file back.
     */
    static async reloadCaddy(options?: { strict?: boolean }): Promise<void> {
        try {
            const { execFile } = await import('child_process');
            const { promisify } = await import('util');
            const execFileAsync = promisify(execFile);
            await execFileAsync('sudo', ['-n', 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile']);
            console.log('✅ Caddy reloaded successfully');
        } catch (error: any) {
            console.error('Failed to reload Caddy:', error);
            if (options?.strict) {
                throw new Error(`Caddy reload failed: ${error?.stderr?.trim() || error?.message || 'unknown error'}`);
            }
        }
    }
}
