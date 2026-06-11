// Pure helpers for build-cache GC: size parsing and prune-command
// construction. No I/O here — everything is unit-testable.

export const BUILDKIT_CONTAINER = 'runnable-buildkit';

// Docker and buildctl print SI-decimal sizes ("19.85GB" = 19.85e9), and
// occasionally binary ones ("104.3MiB"). Unknown input parses to 0 so a
// format drift degrades the usage display instead of crashing the API.
const SIZE_UNITS: Record<string, number> = {
    '': 1, b: 1,
    kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12,
    kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4,
};

export function parseHumanSize(s: string): number {
    const m = s.trim().match(/^([\d.]+)\s*([a-zA-Z]*)$/);
    if (!m) return 0;
    const unit = SIZE_UNITS[m[2].toLowerCase()];
    if (unit === undefined) return 0;
    const n = parseFloat(m[1]);
    return Number.isFinite(n) ? n * unit : 0;
}

// `docker system df --format json` emits one JSON object per line.
export function parseDockerSystemDf(stdout: string): number {
    for (const line of stdout.split('\n')) {
        try {
            const row = JSON.parse(line);
            if (row.Type === 'Build Cache') return parseHumanSize(String(row.Size ?? ''));
        } catch {
            // non-JSON line (warnings etc.) — skip
        }
    }
    return 0;
}

// `buildctl du` ends with a "Total:\t<size>" summary line.
export function parseBuildctlDu(stdout: string): number {
    for (const line of stdout.split('\n')) {
        const m = line.match(/^Total:\s+(\S+)/);
        if (m) return parseHumanSize(m[1]);
    }
    return 0;
}

// A cap of 0 means "no cap": enforcement is skipped, and an explicit
// prune request reclaims everything instead.
export function builderPruneArgs(keepGB: number): string[] {
    if (keepGB <= 0) return ['builder', 'prune', '-af'];
    return ['builder', 'prune', '-f', '--keep-storage', `${keepGB}GB`];
}

export function buildctlPruneArgsModern(keepGB: number): string[] {
    const base = ['exec', BUILDKIT_CONTAINER, 'buildctl', 'prune'];
    if (keepGB <= 0) return base;
    return [...base, '--max-used-space', `${keepGB}GB`];
}

// Older buildkit: --keep-storage takes a plain megabyte integer.
export function buildctlPruneArgsLegacy(keepGB: number): string[] {
    const base = ['exec', BUILDKIT_CONTAINER, 'buildctl', 'prune'];
    if (keepGB <= 0) return base;
    return [...base, '--keep-storage', String(keepGB * 1000)];
}
