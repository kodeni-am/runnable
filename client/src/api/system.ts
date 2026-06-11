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

export const systemApi = {
    stats: () => api.get<SystemStats>('/system/stats'),
    getBuildCache: () => api.get<BuildCacheInfo>('/system/build-cache'),
    getBuildCacheSettings: () => api.get<{ keepGB: number }>('/system/build-cache/settings'),
    updateBuildCache: (keepGB: number) => api.put<{ keepGB: number }>('/system/build-cache', { keepGB }),
    pruneBuildCache: () => api.post<{ freedBytes: number }>('/system/build-cache/prune'),
};
