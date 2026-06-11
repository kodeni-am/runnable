import { describe, it, expect } from 'vitest';
import { assessParallelSafety } from '../composeSafety';

// Fixtures mimic the long-form output of `docker compose config`
const clean = {
    services: {
        web: {
            image: 'web',
            ports: [{ mode: 'ingress', target: 8080, protocol: 'tcp' }],
        },
    },
};

describe('assessParallelSafety', () => {
    it('approves a clean stateless stack', () => {
        expect(assessParallelSafety(clean)).toEqual({ safeToParallel: true, reasons: [] });
    });

    it('flags named volumes', () => {
        const r = assessParallelSafety({
            services: { db: { volumes: [{ type: 'volume', source: 'pgdata', target: '/var/lib/postgresql/data' }] } },
            volumes: { pgdata: {} },
        });
        expect(r.safeToParallel).toBe(false);
        expect(r.reasons[0]).toContain('named volume "pgdata"');
    });

    it('flags external volumes (mounted with a source)', () => {
        const r = assessParallelSafety({
            services: { db: { volumes: [{ type: 'volume', source: 'shared', target: '/data' }] } },
            volumes: { shared: { external: true } },
        });
        expect(r.safeToParallel).toBe(false);
    });

    it('allows anonymous volumes (no source — per-stack)', () => {
        const r = assessParallelSafety({
            services: { app: { volumes: [{ type: 'volume', target: '/cache' }] } },
        });
        expect(r.safeToParallel).toBe(true);
    });

    it('allows tmpfs mounts', () => {
        const r = assessParallelSafety({
            services: { app: { volumes: [{ type: 'tmpfs', target: '/tmp' }] } },
        });
        expect(r.safeToParallel).toBe(true);
    });

    it('flags bind mounts (defense-in-depth — policy rejects them earlier)', () => {
        const r = assessParallelSafety({
            services: { app: { volumes: [{ type: 'bind', source: '/srv/app', target: '/app' }] } },
        });
        expect(r.safeToParallel).toBe(false);
    });

    it('flags fixed host ports', () => {
        const r = assessParallelSafety({
            services: { db: { ports: [{ mode: 'ingress', target: 5432, published: '5432', protocol: 'tcp' }] } },
        });
        expect(r.safeToParallel).toBe(false);
        expect(r.reasons[0]).toContain('5432');
    });

    it('allows published 0 (random host port)', () => {
        const r = assessParallelSafety({
            services: { web: { ports: [{ target: 8080, published: '0' }] } },
        });
        expect(r.safeToParallel).toBe(true);
    });

    it('allows unpublished ports', () => {
        expect(assessParallelSafety(clean).safeToParallel).toBe(true);
    });

    it('flags container_name', () => {
        const r = assessParallelSafety({ services: { web: { container_name: 'my-web' } } });
        expect(r.safeToParallel).toBe(false);
        expect(r.reasons[0]).toContain('container_name');
    });

    it('flags external networks', () => {
        const r = assessParallelSafety({
            services: { web: {} },
            networks: { backbone: { external: true } },
        });
        expect(r.safeToParallel).toBe(false);
        expect(r.reasons[0]).toContain('external');
    });

    it('flags fixed-name networks', () => {
        const r = assessParallelSafety({
            services: { web: {} },
            networks: { internal: { name: 'shared-net' } },
        });
        expect(r.safeToParallel).toBe(false);
        expect(r.reasons[0]).toContain('shared-net');
    });

    it('allows default networks', () => {
        const r = assessParallelSafety({
            services: { web: {} },
            networks: { default: {} },
        });
        expect(r.safeToParallel).toBe(true);
    });

    it('allows the auto-derived default network name compose config emits', () => {
        // `docker compose config -p runnable-6a51f19f` normalizes the default
        // network to name "runnable-6a51f19f_default" — that name follows the
        // project name, so a parallel generation gets its own network.
        const r = assessParallelSafety({
            services: { web: {} },
            networks: { default: { name: 'runnable-6a51f19f_default' } },
        }, { composeProjectName: 'runnable-6a51f19f' });
        expect(r.safeToParallel).toBe(true);
    });

    it('still flags a genuinely fixed network name even with a project name given', () => {
        const r = assessParallelSafety({
            services: { web: {} },
            networks: { internal: { name: 'shared-net' } },
        }, { composeProjectName: 'runnable-6a51f19f' });
        expect(r.safeToParallel).toBe(false);
    });

    it('collects multiple reasons', () => {
        const r = assessParallelSafety({
            services: {
                db: {
                    container_name: 'db',
                    volumes: [{ type: 'volume', source: 'pgdata', target: '/d' }],
                    ports: [{ target: 5432, published: '5432' }],
                },
            },
        });
        expect(r.reasons.length).toBe(3);
    });
});
