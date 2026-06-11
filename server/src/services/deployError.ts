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
