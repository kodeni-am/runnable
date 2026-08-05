import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';
import { config } from '../config';

const execFileAsync = promisify(execFile);

/** Repo root. From server/dist/services (or server/src/services) that is three up. */
export const REPO_ROOT = path.resolve(__dirname, '../../..');
/** Durable state dir, outside the repo — `git reset --hard` must not touch it. */
export const STATE_DIR = path.resolve(config.hosting.servDir, '..');
export const UPDATE_LOG_PATH = path.join(STATE_DIR, 'update.log');
export const UPDATE_STATE_PATH = path.join(STATE_DIR, 'update-state.json');

export type UpdatePhase =
    | 'idle' | 'pulling' | 'installing' | 'building' | 'syncing'
    | 'restarting' | 'verifying' | 'done'
    | 'rolling_back' | 'failed' | 'failed_rollback';

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

const CHECK_TTL_MS = 60 * 60 * 1000; // an unforced check reuses a result this fresh

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
    return execFileAsync('git', args, { cwd: REPO_ROOT }).then(r => r.stdout);
}

export class UpdateService {
    private static cached: UpdateCheckResult | null = null;
    private static inFlight: Promise<UpdateCheckResult> | null = null;

    /** Test seam — clears memoised state between cases. */
    static resetForTests(): void {
        UpdateService.cached = null;
        UpdateService.inFlight = null;
    }

    static async check(force = false): Promise<UpdateCheckResult> {
        const cached = UpdateService.cached;
        if (!force && cached && Date.now() - Date.parse(cached.checkedAt) < CHECK_TTL_MS) {
            return cached;
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
            return result;
        } catch (err: any) {
            const message = String(err?.stderr || err?.message || 'git check failed').trim();
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
}
