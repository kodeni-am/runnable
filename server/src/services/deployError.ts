export type DeployStrategy = 'blue-green' | 'compose-inplace' | 'recreate';
export type HealthGateResult = 'passed' | 'degraded';

export type DeployPhase =
    | 'building' | 'starting' | 'health-check' | 'switching'
    | 'updating-services' | 'retiring' | 'done';

/**
 * Thrown by ProcessService.doDeploy. stillServing is VERIFIED at throw time
 * (same liveness check as the eligibility gate), never assumed — callers use
 * it to decide RUNNING vs ERROR after a failed deploy.
 */
export class DeployError extends Error {
    constructor(
        message: string,
        public readonly stillServing: boolean,
        public readonly strategy: DeployStrategy,
    ) {
        super(message);
        this.name = 'DeployError';
    }
}

/** Stored deploy logs keep the tail: the failure is at the end. */
export const DEPLOY_LOG_MAX_BYTES = 256 * 1024;

/** Keep the last `maxBytes` of a log, cutting on a line boundary. */
export function capDeployLog(text: string, maxBytes: number = DEPLOY_LOG_MAX_BYTES): string {
    const buf = Buffer.from(text, 'utf-8');
    if (buf.length <= maxBytes) return text;
    const tail = buf.subarray(buf.length - maxBytes).toString('utf-8');
    const firstBreak = tail.indexOf('\n');
    return `… (earlier output trimmed)\n${firstBreak >= 0 ? tail.slice(firstBreak + 1) : tail}`;
}

/**
 * The last meaningful lines of a deploy log, for failure notifications.
 * Skips blank lines and the deploy engine's own closing summary, which only
 * repeats the error message the notification already carries.
 */
export function deployLogTail(log: string | null | undefined, lines: number = 20): string {
    if (!log) return '';
    return log.split('\n')
        .map(l => l.trimEnd())
        .filter(l => l.trim() && !l.startsWith('❌ Deploy failed') && !l.startsWith('✓ Previous version'))
        .slice(-lines)
        .join('\n');
}

/** The log deployOrRecreate attached to a failed deploy's error, if any. */
export function deployLogOf(error: unknown): string | undefined {
    const log = (error as { deployLog?: unknown } | null)?.deployLog;
    return typeof log === 'string' ? log : undefined;
}
