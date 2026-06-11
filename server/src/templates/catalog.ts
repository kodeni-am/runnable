/**
 * Curated one-click app templates. Each template is a docker-compose stack
 * provisioned into a new APP project with compose mode enabled. Env values
 * marked `generate: true` get a random secret at provisioning time; the
 * compose files reference them with ${VAR}, which docker compose resolves
 * from the project's .runnable.env file.
 */

export interface TemplateEnvSpec {
    key: string;
    label: string;
    /** Pre-filled value shown to the user (ignored when generate is true) */
    defaultValue?: string;
    /** Generate a random hex secret at provisioning time */
    generate?: boolean;
}

export interface AppTemplate {
    key: string;
    name: string;
    description: string;
    /** 'web' apps are served via the project subdomain; 'database' services are TCP — reachable on the assigned host port */
    kind: 'web' | 'database';
    /** Container-side port of the primary service */
    internalPort: number;
    /** Compose service whose published port Runnable proxies */
    composeService: string;
    env: TemplateEnvSpec[];
    composeYaml: string;
}

export const APP_TEMPLATES: AppTemplate[] = [
    {
        key: 'postgres',
        name: 'PostgreSQL',
        description: 'PostgreSQL 16 database with a persistent volume.',
        kind: 'database',
        internalPort: 5432,
        composeService: 'db',
        env: [
            { key: 'POSTGRES_USER', label: 'Database user', defaultValue: 'app' },
            { key: 'POSTGRES_PASSWORD', label: 'Database password', generate: true },
            { key: 'POSTGRES_DB', label: 'Database name', defaultValue: 'app' },
        ],
        composeYaml: `services:
  db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: \${POSTGRES_USER}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_DB: \${POSTGRES_DB}
    ports:
      - "5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
volumes:
  pgdata:
`,
    },
    {
        key: 'redis',
        name: 'Redis',
        description: 'Redis 7 key-value store, password-protected, with persistence.',
        kind: 'database',
        internalPort: 6379,
        composeService: 'redis',
        env: [
            { key: 'REDIS_PASSWORD', label: 'Redis password', generate: true },
        ],
        composeYaml: `services:
  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: ["sh", "-c", "redis-server --appendonly yes --requirepass \\"$$REDIS_PASSWORD\\""]
    environment:
      REDIS_PASSWORD: \${REDIS_PASSWORD}
    ports:
      - "6379"
    volumes:
      - redisdata:/data
volumes:
  redisdata:
`,
    },
    {
        key: 'mysql',
        name: 'MySQL',
        description: 'MySQL 8 database with a persistent volume.',
        kind: 'database',
        internalPort: 3306,
        composeService: 'db',
        env: [
            { key: 'MYSQL_ROOT_PASSWORD', label: 'Root password', generate: true },
            { key: 'MYSQL_DATABASE', label: 'Database name', defaultValue: 'app' },
        ],
        composeYaml: `services:
  db:
    image: mysql:8
    restart: unless-stopped
    environment:
      MYSQL_ROOT_PASSWORD: \${MYSQL_ROOT_PASSWORD}
      MYSQL_DATABASE: \${MYSQL_DATABASE}
    ports:
      - "3306"
    volumes:
      - mysqldata:/var/lib/mysql
volumes:
  mysqldata:
`,
    },
    {
        key: 'mongodb',
        name: 'MongoDB',
        description: 'MongoDB 7 document database with a persistent volume.',
        kind: 'database',
        internalPort: 27017,
        composeService: 'mongo',
        env: [
            { key: 'MONGO_INITDB_ROOT_USERNAME', label: 'Root user', defaultValue: 'app' },
            { key: 'MONGO_INITDB_ROOT_PASSWORD', label: 'Root password', generate: true },
        ],
        composeYaml: `services:
  mongo:
    image: mongo:7
    restart: unless-stopped
    environment:
      MONGO_INITDB_ROOT_USERNAME: \${MONGO_INITDB_ROOT_USERNAME}
      MONGO_INITDB_ROOT_PASSWORD: \${MONGO_INITDB_ROOT_PASSWORD}
    ports:
      - "27017"
    volumes:
      - mongodata:/data/db
volumes:
  mongodata:
`,
    },
    {
        key: 'uptime-kuma',
        name: 'Uptime Kuma',
        description: 'Self-hosted uptime monitoring with status pages and alerting.',
        kind: 'web',
        internalPort: 3001,
        composeService: 'kuma',
        env: [],
        composeYaml: `services:
  kuma:
    image: louislam/uptime-kuma:1
    restart: unless-stopped
    ports:
      - "3001"
    volumes:
      - kumadata:/app/data
volumes:
  kumadata:
`,
    },
    {
        key: 'n8n',
        name: 'n8n',
        description: 'Workflow automation platform (self-hosted Zapier alternative).',
        kind: 'web',
        internalPort: 5678,
        composeService: 'n8n',
        env: [
            { key: 'N8N_ENCRYPTION_KEY', label: 'Encryption key', generate: true },
        ],
        composeYaml: `services:
  n8n:
    image: n8nio/n8n:latest
    restart: unless-stopped
    environment:
      N8N_ENCRYPTION_KEY: \${N8N_ENCRYPTION_KEY}
      N8N_SECURE_COOKIE: "false"
    ports:
      - "5678"
    volumes:
      - n8ndata:/home/node/.n8n
volumes:
  n8ndata:
`,
    },
    {
        key: 'ghost',
        name: 'Ghost',
        description: 'Modern publishing and newsletter platform (SQLite mode).',
        kind: 'web',
        internalPort: 2368,
        composeService: 'ghost',
        env: [
            { key: 'GHOST_URL', label: 'Public URL of the blog', defaultValue: 'http://localhost:2368' },
        ],
        composeYaml: `services:
  ghost:
    image: ghost:5-alpine
    restart: unless-stopped
    environment:
      url: \${GHOST_URL}
      database__client: sqlite3
      database__connection__filename: /var/lib/ghost/content/data/ghost.db
    ports:
      - "2368"
    volumes:
      - ghostdata:/var/lib/ghost/content
volumes:
  ghostdata:
`,
    },
    {
        key: 'wordpress',
        name: 'WordPress',
        description: 'WordPress with a bundled MariaDB database.',
        kind: 'web',
        internalPort: 80,
        composeService: 'wordpress',
        env: [
            { key: 'WORDPRESS_DB_PASSWORD', label: 'Database password', generate: true },
        ],
        composeYaml: `services:
  wordpress:
    image: wordpress:latest
    restart: unless-stopped
    environment:
      WORDPRESS_DB_HOST: db
      WORDPRESS_DB_USER: wordpress
      WORDPRESS_DB_PASSWORD: \${WORDPRESS_DB_PASSWORD}
      WORDPRESS_DB_NAME: wordpress
    ports:
      - "80"
    volumes:
      - wpdata:/var/www/html
    depends_on:
      - db
  db:
    image: mariadb:11
    restart: unless-stopped
    environment:
      MARIADB_DATABASE: wordpress
      MARIADB_USER: wordpress
      MARIADB_PASSWORD: \${WORDPRESS_DB_PASSWORD}
      MARIADB_RANDOM_ROOT_PASSWORD: "1"
    volumes:
      - wpdb:/var/lib/mysql
volumes:
  wpdata:
  wpdb:
`,
    },
    {
        key: 'grafana',
        name: 'Grafana',
        description: 'Dashboards and observability platform.',
        kind: 'web',
        internalPort: 3000,
        composeService: 'grafana',
        env: [
            { key: 'GF_SECURITY_ADMIN_PASSWORD', label: 'Admin password', generate: true },
        ],
        composeYaml: `services:
  grafana:
    image: grafana/grafana-oss:latest
    restart: unless-stopped
    environment:
      GF_SECURITY_ADMIN_PASSWORD: \${GF_SECURITY_ADMIN_PASSWORD}
    ports:
      - "3000"
    volumes:
      - grafanadata:/var/lib/grafana
volumes:
  grafanadata:
`,
    },
    {
        key: 'vaultwarden',
        name: 'Vaultwarden',
        description: 'Lightweight self-hosted Bitwarden-compatible password manager.',
        kind: 'web',
        internalPort: 80,
        composeService: 'vaultwarden',
        env: [],
        composeYaml: `services:
  vaultwarden:
    image: vaultwarden/server:latest
    restart: unless-stopped
    environment:
      SIGNUPS_ALLOWED: "true"
    ports:
      - "80"
    volumes:
      - vwdata:/data
volumes:
  vwdata:
`,
    },
];

export function getTemplate(key: string): AppTemplate | undefined {
    return APP_TEMPLATES.find(t => t.key === key);
}
