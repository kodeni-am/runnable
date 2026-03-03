export enum Role {
    ADMIN = 'admin',
    USER = 'user',
}

export enum ServerType {
    CADDY = 'caddy',
    APACHE = 'apache',
    NGINX = 'nginx',
    STATIC = 'static',
    APP = 'app',
}

export enum ServiceStatus {
    RUNNING = 'running',
    STOPPED = 'stopped',
    ERROR = 'error',
    DEPLOYING = 'deploying',
}
