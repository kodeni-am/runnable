import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import { config } from '../config';
import { AppError } from '../middleware/errorHandler';

const execFileAsync = promisify(execFile);

/** Repo root. From server/dist/services (or server/src/services) that is three up. */
export const REPO_ROOT = path.resolve(__dirname, '../../..');
/** Durable state dir, outside the repo — `git reset --hard` must not touch it. */
export const STATE_DIR = path.resolve(config.hosting.servDir, '..');
export const UPDATE_LOG_PATH = path.join(STATE_DIR, 'update.log');
export const UPDATE_STATE_PATH = path.join(STATE_DIR, 'update-state.json');
/** The updater is copied here so `git pull` cannot rewrite a running script. */
export const UPDATE_SCRIPT_RUNTIME_PATH = '/run/runnable-update.sh';

// Declared once, here, so the union type and the validation array used by
// readState() can never drift apart.
export const ALL_PHASES = [
    'idle', 'pulling', 'installing', 'building', 'syncing',
    'restarting', 'verifying', 'done', 'rolling_back', 'failed', 'failed_rollback',
] as const;

export type UpdatePhase = typeof ALL_PHASES[number];

/** Phases in which no update is running, so a new one may start. */
export const TERMINAL_PHASES: UpdatePhase[] = ['idle', 'done', 'failed', 'failed_rollback'];

export interface UpdateCommit { sha: string; subject: string; }

export interface UpdateCheckResult {
    current: string;
    behind: number;
    commits: UpdateCommit[];
    checkedAt: string;
    error: string | null;
}

export interface UpdateState {
    phase: UpdatePhase;
    prevCommit: string | null;
    newCommit: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    error: string | null;
}

export interface UpdateStatus extends UpdateCheckResult {
    state: UpdateState;
}

const IDLE_STATE: UpdateState = {
    phase: 'idle', prevCommit: null, newCommit: null,
    startedAt: null, finishedAt: null, error: null,
};

const CHECK_TTL_MS = 60 * 60 * 1000; // an unforced check reuses a result this fresh
const POLL_INTERVAL_MS = 60 * 60 * 1000;

// No process can trap SIGKILL, so an OOM kill, a power loss, or a script that
// dies before its first write (e.g. /run mounted noexec) can leave a
// non-terminal phase on disk forever. A legitimate update runs `npm ci`, a
// full build, a service restart and up to 60s of health polling, which can
// take many minutes on a small VPS. Declaring a live update dead is worse
// than waiting, because it would let a second updater launch on top of the
// first. Sixty minutes is far beyond any real update while still letting the
// instance heal itself without SSH.
export const STALE_CLAIM_MS = 60 * 60 * 1000;

/** `git log --pretty=format:%h %s` output -> commits. */
export function parseCommitLog(stdout: string): UpdateCommit[] {
    return stdout
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
            const spaceAt = line.indexOf(' ');
            if (spaceAt < 1) return null;
            return { sha: line.slice(0, spaceAt), subject: line.slice(spaceAt + 1).trim() };
        })
        .filter((c): c is UpdateCommit => c !== null && c.subject.length > 0);
}

function git(args: string[]): Promise<string> {
    // `git fetch` against an unreachable host blocks for the TCP connect
    // timeout with no cap otherwise, and GET /api/system/update blocks with
    // it. 60s is generous enough for a slow fetch on a big repo.
    return execFileAsync('git', args, { cwd: REPO_ROOT, timeout: 60_000 }).then(r => r.stdout);
}

/**
 * The URL the updater polls to verify the new (or rolled-back) build is
 * healthy. A wildcard bind address (0.0.0.0 / ::) is not a valid poll
 * target — nothing listens "on" a wildcard from the outside — so it falls
 * back to loopback, which is always reachable on the same host.
 */
export function healthUrlFor(host: string, port: number): string {
    const target = (host === '0.0.0.0' || host === '::') ? '127.0.0.1' : host;
    return `http://${target}:${port}/api/health`;
}

export class UpdateService {
    private static cached: UpdateCheckResult | null = null;
    private static inFlight: Promise<UpdateCheckResult> | null = null;
    private static timer: NodeJS.Timeout | null = null;
    // Tracked separately from `cached` because a failed check must not
    // overwrite the last known-good data — but it must still surface on
    // every subsequent unforced call, not just the one that hit the error.
    private static lastCheckError: string | null = null;

    /** Test seam — clears memoised state between cases. */
    static resetForTests(): void {
        UpdateService.cached = null;
        UpdateService.inFlight = null;
        UpdateService.lastCheckError = null;
        UpdateService.stopPolling();
    }

    static async check(force = false): Promise<UpdateCheckResult> {
        const cached = UpdateService.cached;
        if (!force && cached && Date.now() - Date.parse(cached.checkedAt) < CHECK_TTL_MS) {
            // A persistent fetch failure (e.g. origin unreachable for weeks)
            // must stay visible to an unforced GET /api/system/update, not
            // just to whoever happened to click "Check now" when it failed.
            return UpdateService.lastCheckError
                ? { ...cached, error: UpdateService.lastCheckError }
                : cached;
        }
        // Concurrent callers (timer + admin clicking "Check now") share one fetch.
        if (UpdateService.inFlight) return UpdateService.inFlight;

        UpdateService.inFlight = UpdateService.runCheck()
            .finally(() => { UpdateService.inFlight = null; });
        return UpdateService.inFlight;
    }

    private static async runCheck(): Promise<UpdateCheckResult> {
        try {
            await git(['fetch', 'origin', '--quiet']);
            const current = (await git(['rev-parse', '--short', 'HEAD'])).trim();
            const behind = parseInt((await git(['rev-list', '--count', 'HEAD..@{u}'])).trim(), 10) || 0;
            const commits = behind > 0
                ? parseCommitLog(await git(['log', '--pretty=format:%h %s', 'HEAD..@{u}']))
                : [];

            const result: UpdateCheckResult = {
                current, behind, commits,
                checkedAt: new Date().toISOString(),
                error: null,
            };
            UpdateService.cached = result;
            UpdateService.lastCheckError = null;
            return result;
        } catch (err: any) {
            const message = String(err?.stderr || err?.message || 'git check failed').trim();
            UpdateService.lastCheckError = message;
            // A network blip must not destroy a known-good answer. Keep the old
            // data and its original timestamp; surface the error alongside.
            if (UpdateService.cached) {
                return { ...UpdateService.cached, error: message };
            }
            return {
                current: '', behind: 0, commits: [],
                checkedAt: new Date().toISOString(),
                error: message,
            };
        }
    }

    static async readState(): Promise<UpdateState> {
        let raw: string;
        try {
            raw = await fs.readFile(UPDATE_STATE_PATH, 'utf-8');
        } catch {
            // No file at all: nothing has ever run. That is idle, not a fault.
            return { ...IDLE_STATE };
        }
        try {
            const parsed = JSON.parse(raw);
            if (!ALL_PHASES.includes(parsed?.phase)) throw new Error('unknown phase');
            const state: UpdateState = {
                phase: parsed.phase,
                prevCommit: parsed.prevCommit ?? null,
                newCommit: parsed.newCommit ?? null,
                startedAt: parsed.startedAt ?? null,
                finishedAt: parsed.finishedAt ?? null,
                error: parsed.error ?? null,
            };

            // Terminal phases are never rewritten, however old — a finished
            // update stays finished. Only a non-terminal claim can go stale.
            if (!TERMINAL_PHASES.includes(state.phase)) {
                const startedMs = state.startedAt ? Date.parse(state.startedAt) : NaN;
                // A missing or unparseable startedAt can't be aged, so treat it
                // as stale too — an unmeasurable claim must not be able to
                // wedge the instance.
                const isStale = Number.isNaN(startedMs) || (Date.now() - startedMs) > STALE_CLAIM_MS;
                if (isStale) {
                    return {
                        ...state,
                        phase: 'failed',
                        error: 'The updater stopped reporting progress and is presumed dead.',
                    };
                }
            }

            return state;
        } catch {
            // A truncated or garbled file must not strand the UI mid-update.
            return { ...IDLE_STATE, error: 'Update state file is unreadable' };
        }
    }

    static async status(): Promise<UpdateStatus> {
        const [check, state] = await Promise.all([UpdateService.check(), UpdateService.readState()]);
        return { ...check, state };
    }

    static startPolling(): void {
        if (UpdateService.timer) return;
        UpdateService.timer = setInterval(() => {
            UpdateService.check(true).catch(err =>
                console.error('Update check failed:', err?.message || err)
            );
        }, POLL_INTERVAL_MS);
        // Never keep the process alive just for this.
        UpdateService.timer.unref?.();
        console.log('⬆️  Update checker started (interval: 60m)');
    }

    static stopPolling(): void {
        if (UpdateService.timer) {
            clearInterval(UpdateService.timer);
            UpdateService.timer = null;
        }
    }

    static async start(): Promise<void> {
        const [check, state] = await Promise.all([
            UpdateService.check(true),
            UpdateService.readState(),
        ]);

        if (!TERMINAL_PHASES.includes(state.phase)) {
            throw new AppError('An update is already in progress', 409);
        }
        if (check.error) {
            throw new AppError(`Cannot check for updates: ${check.error}`, 409);
        }
        // -uno: ignore untracked files. `git pull --ff-only` succeeds fine with
        // untracked files present (it only fails if an incoming commit would
        // overwrite one, and update.sh's abort() already handles that case
        // safely with the tree unchanged). Without -uno, a single orphaned
        // upload under ./storage/ (untracked, since only server/storage/ is
        // gitignored) would refuse every future update forever.
        const dirty = (await git(['status', '--porcelain', '-uno'])).trim();
        if (dirty) {
            throw new AppError(
                'The installation has uncommitted changes — refusing to update. Resolve them on the server first.',
                409,
            );
        }
        if (check.behind === 0) {
            throw new AppError('Already up to date', 400);
        }

        // Atomically claim the update before launching, so no concurrent start() can pass all gates.
        const claimedState: UpdateState = {
            phase: 'pulling',
            prevCommit: check.current,
            newCommit: null,
            startedAt: new Date().toISOString(),
            finishedAt: null,
            error: null,
        };
        const tmpPath = `${UPDATE_STATE_PATH}.tmp`;
        await fs.writeFile(tmpPath, JSON.stringify(claimedState, null, 2), 'utf-8');
        await fs.rename(tmpPath, UPDATE_STATE_PATH);

        try {
            // Copy the script out of the repo: `git pull` rewrites update.sh, and
            // bash reads a script incrementally by byte offset, so rewriting it
            // mid-run causes arbitrary misexecution.
            const tmpScript = `${UPDATE_SCRIPT_RUNTIME_PATH}.tmp`;
            await execFileAsync('install', [
                '-m700', path.join(REPO_ROOT, 'update.sh'), tmpScript,
            ], {});

            // Atomically move the script into place.
            await execFileAsync('mv', ['-f', tmpScript, UPDATE_SCRIPT_RUNTIME_PATH], {});

            // Its own transient unit, outside this service's cgroup, so
            // `systemctl restart runnable` partway through does not kill it.
            // The copied script cannot infer the repo location, so pass it.
            await execFileAsync('systemd-run', [
                '--unit=runnable-update',
                '--collect',
                // Must never exceed STALE_CLAIM_MS: --collect only reaps a unit
                // once it goes inactive/failed, not one stuck ACTIVE (e.g. `npm
                // ci` hanging on a stalled registry). Without a cap, readState()
                // would declare the claim stale and let start() write a fresh
                // claim while the old unit is still running, so the next launch
                // collides with "already exists" forever. Derived from the same
                // constant so the two can never drift apart.
                `--property=RuntimeMaxSec=${STALE_CLAIM_MS / 1000}`,
                `--setenv=INSTALL_DIR=${REPO_ROOT}`,
                `--setenv=STATE_DIR=${STATE_DIR}`,
                // The API's port (and bind host) are configurable; the launcher
                // must pass them explicitly or verification (and the matching
                // rollback health check) silently checks the wrong address on
                // any instance where PORT/HOST were changed from the defaults.
                `--setenv=HEALTH_URL=${healthUrlFor(config.host, config.port)}`,
                // Independently hardcoded in setup.sh/deploy.sh/the Caddy root —
                // without this, a Caddy root that differs from the default
                // silently rsyncs the frontend into the wrong directory.
                `--setenv=WEB_DIR=${config.webDir}`,
                UPDATE_SCRIPT_RUNTIME_PATH,
            ], {});
        } catch (err: any) {
            const stderr = err?.stderr || '';
            const message = err?.message || '';
            // If another updater's unit exists, don't touch our claim; another process owns it.
            if (/already exists/i.test(stderr) || /already exists/i.test(message)) {
                throw new AppError('An update is already in progress', 409);
            }
            // Any other failure: revert the claim so the next start() can retry.
            const failedState: UpdateState = {
                phase: 'failed',
                prevCommit: check.current,
                newCommit: null,
                startedAt: claimedState.startedAt,
                finishedAt: new Date().toISOString(),
                error: stderr || message || 'Launch failed',
            };
            const failTmpPath = `${UPDATE_STATE_PATH}.tmp`;
            await fs.writeFile(failTmpPath, JSON.stringify(failedState, null, 2), 'utf-8');
            await fs.rename(failTmpPath, UPDATE_STATE_PATH);
            throw new AppError(`Failed to start update: ${stderr || message}`, 500);
        }
    }
}
