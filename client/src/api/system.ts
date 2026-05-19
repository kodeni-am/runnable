import api from './client';

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
};
