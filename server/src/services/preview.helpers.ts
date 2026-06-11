import crypto from 'crypto';

/** The slice of a GitHub `pull_request` webhook payload the lifecycle needs. */
export interface PullRequestInfo {
    number: number;
    head: { ref: string; repo: { full_name: string } | null };
    base: { repo: { full_name: string } };
}

/**
 * A PR is "from a fork" when its head repo differs from the base repo (or the
 * head repo is null — a deleted fork). Fork PRs contain untrusted code and are
 * never auto-built.
 */
export function isForkPR(pr: PullRequestInfo): boolean {
    return !pr.head.repo || pr.head.repo.full_name !== pr.base.repo.full_name;
}

// Leave headroom under the 63-char DNS label limit.
const MAX_LABEL = 50;

/**
 * Deterministic, collision-resistant preview subdomain: `pr-<n>-<slug>-<hash>`,
 * where `slug` is the (truncated) parent subdomain and `hash` is a short digest
 * of the parent project id (so two different parents never collide, and a real
 * project literally named `pr-<n>-...` won't either). Stable for a given
 * (parentSubdomain, prNumber, parentProjectId), so reopening a PR reuses it.
 */
export function derivePreviewSubdomain(parentSubdomain: string, prNumber: number, parentProjectId: string): string {
    const hash = crypto.createHash('sha256').update(parentProjectId).digest('hex').slice(0, 6);
    const prefix = `pr-${prNumber}-`;
    const suffix = `-${hash}`;
    const room = MAX_LABEL - prefix.length - suffix.length;
    const slug = parentSubdomain.slice(0, Math.max(1, room));
    return `${prefix}${slug}${suffix}`.toLowerCase();
}

/** parent env ⊕ overrides (override wins) ⊕ injected (always wins). */
export function mergePreviewEnv(
    parentEnv: Record<string, string> | null | undefined,
    overrides: Record<string, string> | null | undefined,
    injected: Record<string, string>,
): Record<string, string> {
    return { ...(parentEnv || {}), ...(overrides || {}), ...injected };
}

export function previewHostname(subdomain: string, baseDomain: string): string {
    return `${subdomain}.${baseDomain}`;
}

/** True when a preview has been idle longer than its TTL (in days). */
export function isPreviewExpired(
    lastActivityAt: Date | string | null | undefined,
    ttlDays: number,
    nowMs: number,
): boolean {
    if (!lastActivityAt) return false;
    const ageMs = nowMs - new Date(lastActivityAt).getTime();
    return ageMs > ttlDays * 24 * 60 * 60 * 1000;
}
