// server/src/services/buildCache.service.ts
// Enforces the admin-configured build-cache cap. Two caches exist:
//  - the Docker daemon's builder cache (compose builds)
//  - the runnable-buildkit container's cache (railpack builds)
// Pruning concurrently with builds is safe: BuildKit never evicts cache
// referenced by an in-flight build.
import { execFile } from 'child_process';
import { promisify } from 'util';
import { AppSettingsService } from './appSettings.service';
import {
    BUILDKIT_CONTAINER,
    builderPruneArgsModern,
    builderPruneArgsLegacy,
    buildctlPruneArgs,
    parseDockerSystemDf,
    parseBuildctlDu,
} from './buildCache.helpers';

const execFileAsync = promisify(execFile);
// Prunes of tens of GB can take minutes; outputs can be large.
const EXEC_OPTS = { timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 };
// Read-only usage queries get a shorter timeout than prunes so a wedged
// daemon doesn't hold the admin UI for 10 minutes — but `docker system df`
// legitimately takes 30s+ when the build cache holds ~1000 entries
// (observed in production), so this must stay well above that.
const READ_OPTS = { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 };

export interface BuildCacheUsage {
    daemonBytes: number;
    buildkitBytes: number;
}

export class BuildCacheService {
    // Two deploys finishing together must not run overlapping prunes —
    // the second joins the first run instead.
    private static inFlight: Promise<void> | null = null;

    static async usage(): Promise<BuildCacheUsage> {
        const { stdout } = await execFileAsync('docker', ['system', 'df', '--format', 'json'], READ_OPTS);
        const daemonBytes = parseDockerSystemDf(stdout);

        let buildkitBytes = 0;
        if (await BuildCacheService.buildkitUp()) {
            try {
                const du = await execFileAsync('docker', ['exec', BUILDKIT_CONTAINER, 'buildctl', 'du'], READ_OPTS);
                buildkitBytes = parseBuildctlDu(du.stdout);
            } catch {
                // builder container present but not responding — report 0
            }
        }
        return { daemonBytes, buildkitBytes };
    }

    /** Post-deploy hook. Never throws; never blocks the deploy path. */
    static enforceCap(): Promise<void> {
        if (BuildCacheService.inFlight) return BuildCacheService.inFlight;
        const run = (async () => {
            try {
                const { buildCacheKeepGB } = await AppSettingsService.get();
                if (buildCacheKeepGB <= 0) return; // 0 means disabled
                await BuildCacheService.prune(buildCacheKeepGB);
            } catch (err: any) {
                console.error('[BuildCache] enforcement failed:', err?.message || err);
            } finally {
                BuildCacheService.inFlight = null;
            }
        })();
        BuildCacheService.inFlight = run;
        return run;
    }

    /**
     * Explicit "Prune now". Cap 0 means full prune. Throws on failure.
     * Intentionally bypasses the inFlight guard — docker/buildkit serialize
     * concurrent prunes internally, and sharing the guard would swallow the
     * errors this method must surface to the API.
     */
    static async pruneToCap(): Promise<{ freedBytes: number }> {
        const before = await BuildCacheService.usage();
        const { buildCacheKeepGB } = await AppSettingsService.get();
        await BuildCacheService.prune(buildCacheKeepGB);
        const after = await BuildCacheService.usage();
        const freedBytes = Math.max(0,
            (before.daemonBytes + before.buildkitBytes) - (after.daemonBytes + after.buildkitBytes));
        return { freedBytes };
    }

    private static async prune(keepGB: number): Promise<void> {
        try {
            await execFileAsync('docker', builderPruneArgsModern(keepGB), EXEC_OPTS);
        } catch (err: any) {
            const msg = String(err?.stderr || err?.message || '');
            // Older Docker doesn't know --max-used-space; retry with the
            // legacy flag. Any other failure propagates.
            if (keepGB > 0 && /unknown flag|flag provided but not defined/i.test(msg)) {
                await execFileAsync('docker', builderPruneArgsLegacy(keepGB), EXEC_OPTS);
            } else {
                throw err;
            }
        }

        if (!(await BuildCacheService.buildkitUp())) return;
        await execFileAsync('docker', buildctlPruneArgs(keepGB), EXEC_OPTS);
    }

    private static async buildkitUp(): Promise<boolean> {
        try {
            const { stdout } = await execFileAsync('docker',
                // ^...$ anchors: docker's name filter is a regex substring
                // match, and e.g. "runnable-buildkit-dev" must not count.
                ['ps', '--filter', `name=^${BUILDKIT_CONTAINER}$`, '--format', '{{.Status}}'], READ_OPTS);
            return stdout.includes('Up');
        } catch {
            return false;
        }
    }
}
