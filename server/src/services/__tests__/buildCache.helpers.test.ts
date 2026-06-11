import { describe, it, expect } from 'vitest';
import {
    parseHumanSize,
    parseDockerSystemDf,
    parseBuildctlDu,
    builderPruneArgsModern,
    builderPruneArgsLegacy,
    buildctlPruneArgs,
} from '../buildCache.helpers';

describe('parseHumanSize', () => {
    it('parses docker-style SI sizes', () => {
        expect(parseHumanSize('19.85GB')).toBe(19.85e9);
        expect(parseHumanSize('163.8kB')).toBe(163.8e3);
        expect(parseHumanSize('104.3MiB')).toBeCloseTo(104.3 * 1024 * 1024);
        expect(parseHumanSize('0B')).toBe(0);
        expect(parseHumanSize('512')).toBe(512);
    });
    it('returns 0 for unparseable input', () => {
        expect(parseHumanSize('')).toBe(0);
        expect(parseHumanSize('n/a')).toBe(0);
    });
});

describe('parseDockerSystemDf', () => {
    // `docker system df --format json` emits one JSON object per line.
    const sample = [
        '{"Active":"4","Reclaimable":"1.284GB (5%)","Size":"21.47GB","TotalCount":"6","Type":"Images"}',
        '{"Active":"9","Reclaimable":"16.38kB (10%)","Size":"163.8kB","TotalCount":"11","Type":"Containers"}',
        '{"Active":"5","Reclaimable":"0B (0%)","Size":"149.6MB","TotalCount":"5","Type":"Local Volumes"}',
        '{"Active":"0","Reclaimable":"19.85GB","Size":"19.85GB","TotalCount":"223","Type":"Build Cache"}',
    ].join('\n');

    it('extracts the Build Cache size in bytes', () => {
        expect(parseDockerSystemDf(sample)).toBe(19.85e9);
    });
    it('returns 0 when the Build Cache row is missing', () => {
        expect(parseDockerSystemDf('{"Type":"Images","Size":"1GB"}')).toBe(0);
    });
    it('survives garbage lines', () => {
        expect(parseDockerSystemDf('WARNING: something\n' + sample)).toBe(19.85e9);
    });
});

describe('parseBuildctlDu', () => {
    const sample = [
        'ID\t\t\t\t\t\t\tRECLAIMABLE\tSIZE\t\tLAST ACCESSED',
        'sf53q...\t\t\t\t\t\ttrue\t\t1.44GB',
        'Shared:\t\t4.87GB',
        'Private:\t14.99GB',
        'Reclaimable:\t19.85GB',
        'Total:\t\t19.85GB',
    ].join('\n');

    it('extracts the Total line in bytes', () => {
        expect(parseBuildctlDu(sample)).toBe(19.85e9);
    });
    it('returns 0 when no Total line exists', () => {
        expect(parseBuildctlDu('')).toBe(0);
        expect(parseBuildctlDu('garbage')).toBe(0);
    });
});

describe('prune args builders', () => {
    it('docker builder prune to a cap (modern flag)', () => {
        expect(builderPruneArgsModern(10)).toEqual(['builder', 'prune', '-f', '--max-used-space', '10GB']);
    });
    it('docker builder prune to a cap (legacy flag)', () => {
        expect(builderPruneArgsLegacy(10)).toEqual(['builder', 'prune', '-f', '--keep-storage', '10GB']);
    });
    it('docker builder full prune when cap is 0 (both variants)', () => {
        expect(builderPruneArgsModern(0)).toEqual(['builder', 'prune', '-af']);
        expect(builderPruneArgsLegacy(0)).toEqual(['builder', 'prune', '-af']);
    });
    it('docker builder full prune when cap is negative (both variants)', () => {
        expect(builderPruneArgsModern(-1)).toEqual(['builder', 'prune', '-af']);
        expect(builderPruneArgsLegacy(-1)).toEqual(['builder', 'prune', '-af']);
    });
    it('buildctl prune uses keep-storage with MB integer', () => {
        expect(buildctlPruneArgs(10)).toEqual(
            ['exec', 'runnable-buildkit', 'buildctl', 'prune', '--keep-storage', '10000']);
    });
    it('buildctl full prune when cap is 0 or negative', () => {
        expect(buildctlPruneArgs(0)).toEqual(['exec', 'runnable-buildkit', 'buildctl', 'prune']);
        expect(buildctlPruneArgs(-1)).toEqual(['exec', 'runnable-buildkit', 'buildctl', 'prune']);
    });
});
