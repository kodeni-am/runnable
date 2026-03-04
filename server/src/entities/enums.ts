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
    BUILDING = 'building',
}

export enum ProjectPermission {
    CAN_START = 'canStart',
    CAN_EDIT_CONFIG = 'canEditConfig',
    CAN_EDIT_DOMAINS = 'canEditDomains',
    CAN_EDIT_FILES = 'canEditFiles',
    CAN_DELETE = 'canDelete',
    CAN_VIEW_LOGS = 'canViewLogs',
    CAN_VIEW_FILES = 'canViewFiles',
    CAN_VIEW_DOMAINS = 'canViewDomains',
    CAN_VIEW_GITHUB = 'canViewGithub',
    CAN_VIEW_SETTINGS = 'canViewSettings',
}
