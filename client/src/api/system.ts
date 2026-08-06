import api from './client';

export interface BuildCacheInfo {
    usageBytes: number;
    daemonBytes: number;
    buildkitBytes: number;
    keepGB: number;
}

export interface SystemStats {
    hostname: string;
    platform: string;
    uptimeSeconds: number;
    cpu: {
        usedPercent: number;
        cores: number;
        model: string;
        loadAvg: number[];
        perCore: number[];
    };
    memory: {
        total: number;
        used: number;
        free: number;
        usedPercent: number;
    };
    disk: {
        total: number;
        used: number;
        free: number;
        usedPercent: number;
        mount: string;
    };
    network: {
        rxBytesPerSec: number;
        txBytesPerSec: number;
    };
    timestamp: string;
}

export interface UpdateCommit { sha: string; subject: string; }

export interface UpdateStatus {
    current: string;
    behind: number;
    commits: UpdateCommit[];
    checkedAt: string;
    error: string | null;
    state: {
        phase: string;
        prevCommit: string | null;
        newCommit: string | null;
        startedAt: string | null;
        finishedAt: string | null;
        error: string | null;
    };
}

export const systemApi = {
    stats: () => api.get<SystemStats>('/system/stats'),
    getRegistration: () =>
        api.get<{ allowPublicRegistration: boolean }>('/system/registration'),
    updateRegistration: (allowPublicRegistration: boolean) =>
        api.put<{ allowPublicRegistration: boolean }>('/system/registration', { allowPublicRegistration }),
    getBuildCache: () => api.get<BuildCacheInfo>('/system/build-cache'),
    getBuildCacheSettings: () => api.get<{ keepGB: number }>('/system/build-cache/settings'),
    updateBuildCache: (keepGB: number) => api.put<{ keepGB: number }>('/system/build-cache', { keepGB }),
    pruneBuildCache: () => api.post<{ freedBytes: number }>('/system/build-cache/prune'),
    getUpdate: () => api.get<UpdateStatus>('/system/update'),
    checkUpdate: () => api.post<UpdateStatus>('/system/update/check'),
    startUpdate: () => api.post<UpdateStatus>('/system/update'),
    getUpdateLog: () => api.get<{ log: string }>('/system/update/log'),
};
