export interface ParallelSafety {
    safeToParallel: boolean;
    reasons: string[];
}

/**
 * Decide whether a compose stack can run twice in parallel (blue-green
 * tier 2) or must be updated in place (tier 3). Input is the parsed output
 * of `docker compose config` — long-form, interpolated, anchors resolved —
 * the same normalization contract ComposePolicyService.validate relies on.
 *
 * Unsafe-to-parallel triggers:
 * - named/external volumes (a parallel stack would start empty or write the
 *   same data dir concurrently); anonymous volumes and tmpfs are per-stack
 *   and safe
 * - bind mounts (concurrent writers; the security policy rejects these
 *   earlier — kept as defense-in-depth)
 * - fixed host ports (the parallel stack would collide binding them)
 * - container_name (daemon-global)
 * - external or fixed-name networks (both stacks would join the same network
 *   with identical service aliases and DNS would round-robin across them)
 */
export function assessParallelSafety(
    doc: any,
    opts?: { composeProjectName?: string },
): ParallelSafety {
    const reasons: string[] = [];
    const services = (doc?.services && typeof doc.services === 'object') ? doc.services : {};

    for (const [name, svcRaw] of Object.entries(services)) {
        const svc = svcRaw as Record<string, any>;
        if (!svc || typeof svc !== 'object') continue;

        if (svc.container_name) {
            reasons.push(`service "${name}" sets container_name "${svc.container_name}" (container names are daemon-global)`);
        }

        for (const p of Array.isArray(svc.ports) ? svc.ports : []) {
            const published = (p && typeof p === 'object') ? p.published
                : (typeof p === 'string' && p.includes(':')) ? p.split(':')[0] : undefined;
            if (published !== undefined && String(published) !== '0' && String(published) !== '') {
                reasons.push(`service "${name}" publishes fixed host port ${published}`);
            }
        }

        for (const v of Array.isArray(svc.volumes) ? svc.volumes : []) {
            if (v && typeof v === 'object') {
                if (v.type === 'volume' && v.source) {
                    reasons.push(`service "${name}" mounts named volume "${v.source}"`);
                } else if (v.type === 'bind') {
                    reasons.push(`service "${name}" uses a bind mount (${v.source})`);
                }
                // type 'volume' without source = anonymous (per-stack) — safe; tmpfs — safe
            } else if (typeof v === 'string' && v.includes(':')) {
                // Defensive: short form shouldn't survive `compose config`
                reasons.push(`service "${name}" mounts volume "${v.split(':')[0]}"`);
            }
        }
    }

    const networks = (doc?.networks && typeof doc.networks === 'object') ? doc.networks : {};
    for (const [name, netRaw] of Object.entries(networks)) {
        const net = (netRaw ?? {}) as Record<string, any>;
        if (net.external) {
            reasons.push(`network "${name}" is external (would be shared by both stacks)`);
        } else if (net.name) {
            // `docker compose config -p <project>` normalizes every network
            // with an explicit name; the auto-derived "<project>_<key>" form
            // follows the project name, so a parallel generation gets its own
            // network — only a name that DOESN'T follow it is genuinely fixed.
            const autoDerived = opts?.composeProjectName
                && net.name === `${opts.composeProjectName}_${name}`;
            if (!autoDerived) {
                reasons.push(`network "${name}" has a fixed name "${net.name}" (would be shared by both stacks)`);
            }
        }
    }

    return { safeToParallel: reasons.length === 0, reasons };
}
