# Preview/PR Deployments — Phase 3 (TLS / Config) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make preview environments reachable over HTTPS at their preview hostname. Thread a per-project `baseDomain` override and an `onDemandTls` flag into the Caddy config generator, add an unauthenticated `tls-check` endpoint that gates on-demand certificate issuance to live preview hostnames, and add the global `on_demand_tls` block + operator docs to `setup.sh`.

**Architecture:** Preview projects already carry a `baseDomain` column (Phase 1) set to the parent's `previewBaseDomain` (Phase 2). Caddy's config generator currently hardcodes `config.hosting.baseDomain`; this phase lets a preview emit `<subdomain>.<previewBaseDomain>` with `tls { on_demand }`. Caddy asks an internal endpoint before issuing a cert for any on-demand hostname; the endpoint returns 200 only when the hostname matches a live preview project, preventing arbitrary cert issuance. The operator adds one wildcard DNS record.

**Tech Stack:** TypeScript, Express 5, TypeORM 0.3 (Postgres), Caddy, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-11-preview-deployments-design.md` (TLS & config section)
**Builds on:** Phase 1 + Phase 2 on branch `feat/preview-deployments`.

**Working directory for all commands:** `/Users/araasryan/Projects/runnable/server` unless stated.

**Scope (Phase 3 only):** Caddy `baseDomain`/`onDemandTls` emission; the `tls-check` endpoint; the Caddyfile `on_demand_tls` block + docs. NOT here: Settings UI / Previews tab / TTL sweep / the enable-previews write path (all Phase 4). Nginx/Apache generators are NOT changed — previews are APP-type and only ever use the Caddy generator.

---

## File Structure (Phase 3)

- **Modify** `server/src/services/serverConfig.service.ts` — `ServerConfigOptions` gains `baseDomain?` + `onDemandTls?`; `generateConfig` sanitizes `baseDomain`; `generateCaddyConfig` uses the override and emits `tls { on_demand }`.
- **Create** `server/src/services/__tests__/serverConfig.service.test.ts` — config-generation tests.
- **Modify** `server/src/services/process.service.ts` — doStart passes `baseDomain` + `onDemandTls`.
- **Modify** `server/src/routes/projects.routes.ts` — reload-proxy passes `baseDomain` + `onDemandTls`.
- **Modify** `server/src/services/domain.service.ts` — regenerate passes `baseDomain` + `onDemandTls`.
- **Create** `server/src/services/tlsCheck.service.ts` — `TlsCheckService.isLivePreviewHostname(domain)`.
- **Create** `server/src/services/__tests__/tlsCheck.service.test.ts` — endpoint-decision tests.
- **Create** `server/src/routes/internal.routes.ts` — `GET /tls-check` (unauthenticated, rate-limited).
- **Modify** `server/src/index.ts` — mount the internal router outside the auth chain.
- **Modify** `setup.sh` — global `on_demand_tls` block + operator doc line.

---

## Task 1: Caddy config — `baseDomain` override + on-demand TLS (TDD)

**Files:**
- Modify: `server/src/services/serverConfig.service.ts`
- Create: `server/src/services/__tests__/serverConfig.service.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `server/src/services/__tests__/serverConfig.service.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { ServerConfigService } from '../serverConfig.service';
import { ServerType } from '../../entities';

describe('generateConfig — preview (Caddy) options', () => {
    it('uses the baseDomain override and emits on-demand TLS', async () => {
        const out = await ServerConfigService.generateConfig({
            subdomain: 'pr-5-app-abc123',
            directoryPath: '/srv/x',
            port: 12345,
            serverType: ServerType.APP,
            baseDomain: 'preview.example.com',
            onDemandTls: true,
        });
        expect(out).toContain('pr-5-app-abc123.preview.example.com');
        expect(out).toMatch(/tls\s*\{\s*on_demand\s*\}/);
        expect(out).toContain('reverse_proxy localhost:12345');
    });

    it('does NOT emit on-demand TLS for a normal project', async () => {
        const out = await ServerConfigService.generateConfig({
            subdomain: 'app',
            directoryPath: '/srv/a',
            port: 8080,
            serverType: ServerType.APP,
        });
        expect(out).not.toContain('on_demand');
        expect(out).toContain('reverse_proxy localhost:8080');
    });

    it('rejects an invalid baseDomain', async () => {
        await expect(ServerConfigService.generateConfig({
            subdomain: 'app',
            directoryPath: '/srv/a',
            port: 8080,
            serverType: ServerType.APP,
            baseDomain: 'bad domain!',
        })).rejects.toThrow();
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/services/__tests__/serverConfig.service.test.ts`
Expected: FAIL — `baseDomain`/`onDemandTls` aren't accepted, on-demand TLS not emitted.

- [ ] **Step 3: Extend `ServerConfigOptions`**

In `server/src/services/serverConfig.service.ts`, change the interface to:
```ts
interface ServerConfigOptions {
    subdomain: string;
    directoryPath: string;
    port: number;
    serverType: ServerType;
    customDomains?: { domain: string, redirectTarget: string | null }[];
    /** Overrides config.hosting.baseDomain (preview environments). */
    baseDomain?: string;
    /** Emit `tls { on_demand }` so Caddy fetches the cert lazily (previews). */
    onDemandTls?: boolean;
}
```

- [ ] **Step 4: Sanitize `baseDomain` in `generateConfig`**

In `generateConfig`, after the `customDomains` sanitize block (right before the `switch`), add:
```ts
        if (options.baseDomain) {
            options.baseDomain = ServerConfigService.sanitizeDomain(options.baseDomain);
        }
```

- [ ] **Step 5: Replace `generateCaddyConfig`**

Replace the entire `generateCaddyConfig` method with:
```ts
    static generateCaddyConfig(options: ServerConfigOptions): string {
        const baseDomain = options.baseDomain || config.hosting.baseDomain;
        const redirectedDomains = options.customDomains?.filter(d => Boolean(d.redirectTarget)) || [];
        const normalCustomDomains = options.customDomains?.filter(d => !d.redirectTarget)?.map(d => d.domain) || [];

        const mainDomains = [
            `${options.subdomain}.${baseDomain}`,
            ...normalCustomDomains,
        ];

        let configStr = '';

        // Add redirect blocks for each domain that has a redirectTarget
        for (const rd of redirectedDomains) {
            configStr += `${rd.domain} {\n  redir https://${rd.redirectTarget}{uri}\n}\n\n`;
        }

        const domainList = mainDomains.join(', ');
        // Preview hostnames use on-demand TLS: Caddy fetches the cert on first
        // request (gated by the tls-check ask endpoint) instead of up front.
        const tlsBlock = options.onDemandTls ? '  tls {\n    on_demand\n  }\n' : '';

        if (options.serverType === ServerType.STATIC) {
            configStr += `${domainList} {
${tlsBlock}  root * ${options.directoryPath}
  file_server
  encode gzip zstd
  log {
    output file /var/log/caddy/${options.subdomain}.log
  }
}
`;
        } else {
            configStr += `${domainList} {
${tlsBlock}  reverse_proxy localhost:${options.port}
  encode gzip zstd
  log {
    output file /var/log/caddy/${options.subdomain}.log
  }
}
`;
        }

        return configStr;
    }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -- src/services/__tests__/serverConfig.service.test.ts`
Expected: PASS — all three config tests green.

- [ ] **Step 7: Type-check**

Run: `npx tsc --noEmit`
Expected: no output, exit 0.

- [ ] **Step 8: Commit**

```bash
git add server/src/services/serverConfig.service.ts server/src/services/__tests__/serverConfig.service.test.ts
git commit -m "feat: Caddy config baseDomain override + on-demand TLS for previews"
```

---

## Task 2: Thread `baseDomain` + `onDemandTls` from the three call sites

The three places that build `ServerConfigOptions` must pass the project's `baseDomain` and set `onDemandTls` for preview projects.

**Files:**
- Modify: `server/src/services/process.service.ts`
- Modify: `server/src/routes/projects.routes.ts`
- Modify: `server/src/services/domain.service.ts`

- [ ] **Step 1: process.service doStart**

In `server/src/services/process.service.ts`, find the `ServerConfigService.generateConfig({ ... })` call inside `doStart` (the options object includes `subdomain`, `directoryPath`, `port`, `serverType`, `customDomains`). Add two properties to that object:
```ts
            baseDomain: (project as any).baseDomain || undefined,
            onDemandTls: (project as any).isPreview === true,
```
(Place them alongside the existing keys, e.g. after the `customDomains: ...` entry.)

- [ ] **Step 2: projects.routes reload-proxy**

In `server/src/routes/projects.routes.ts`, find the `ServerConfigService.generateConfig({ ... })` call inside the `POST '/:id/reload-proxy'` handler. Add to that options object:
```ts
            baseDomain: project.baseDomain || undefined,
            onDemandTls: project.isPreview === true,
```

- [ ] **Step 3: domain.service regenerate**

In `server/src/services/domain.service.ts`, find the `ServerConfigService.generateConfig({ ... })` call (inside the config-regeneration method). Add to that options object:
```ts
            baseDomain: project.baseDomain || undefined,
            onDemandTls: project.isPreview === true,
```
(Custom-domain regeneration only runs for normal projects, so `onDemandTls` will be false there — passing it keeps the call sites uniform and correct if a preview ever has a custom domain.)

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no output, exit 0.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/process.service.ts server/src/routes/projects.routes.ts server/src/services/domain.service.ts
git commit -m "feat: pass baseDomain + onDemandTls to config generation"
```

---

## Task 3: `tls-check` decision service (TDD)

**Files:**
- Create: `server/src/services/tlsCheck.service.ts`
- Create: `server/src/services/__tests__/tlsCheck.service.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `server/src/services/__tests__/tlsCheck.service.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findOne = vi.fn();
vi.mock('../../config/data-source', () => ({
    AppDataSource: { getRepository: () => ({ findOne }) },
}));

import { TlsCheckService } from '../tlsCheck.service';

beforeEach(() => { findOne.mockReset(); });

describe('TlsCheckService.isLivePreviewHostname', () => {
    it('returns true when the hostname matches a live preview', async () => {
        findOne.mockResolvedValue({ subdomain: 'pr-5-app-abc', baseDomain: 'preview.example.com', isPreview: true });
        expect(await TlsCheckService.isLivePreviewHostname('pr-5-app-abc.preview.example.com')).toBe(true);
        // looked up by the first DNS label
        expect(findOne).toHaveBeenCalledWith({ where: { subdomain: 'pr-5-app-abc', isPreview: true } });
    });

    it('returns false when no preview has that subdomain', async () => {
        findOne.mockResolvedValue(null);
        expect(await TlsCheckService.isLivePreviewHostname('pr-9-x.preview.example.com')).toBe(false);
    });

    it('returns false when the base domain does not match the stored one', async () => {
        findOne.mockResolvedValue({ subdomain: 'pr-5-app-abc', baseDomain: 'preview.example.com', isPreview: true });
        expect(await TlsCheckService.isLivePreviewHostname('pr-5-app-abc.evil.com')).toBe(false);
    });

    it('returns false for a domain with no dot', async () => {
        expect(await TlsCheckService.isLivePreviewHostname('localhost')).toBe(false);
        expect(findOne).not.toHaveBeenCalled();
    });

    it('returns false for empty input', async () => {
        expect(await TlsCheckService.isLivePreviewHostname('')).toBe(false);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/services/__tests__/tlsCheck.service.test.ts`
Expected: FAIL — cannot resolve `../tlsCheck.service`.

- [ ] **Step 3: Implement the service**

Create `server/src/services/tlsCheck.service.ts`:
```ts
import { AppDataSource } from '../config/data-source';
import { Project } from '../entities';

/**
 * Decides whether Caddy may issue an on-demand certificate for a hostname.
 * Only live preview hostnames qualify, so Caddy can't be tricked into fetching
 * certs for arbitrary domains pointed at this server.
 *
 * A preview subdomain is a single DNS label (no dots), so the hostname splits
 * into `<subdomain>.<baseDomain>` at the first dot. The subdomain is globally
 * unique, so this is a single indexed lookup.
 */
export class TlsCheckService {
    static async isLivePreviewHostname(domain: string): Promise<boolean> {
        const host = (domain || '').trim().toLowerCase();
        const firstDot = host.indexOf('.');
        if (firstDot < 1) return false;

        const subdomain = host.slice(0, firstDot);
        const project = await AppDataSource.getRepository(Project).findOne({
            where: { subdomain, isPreview: true },
        });
        if (!project || !project.baseDomain) return false;

        return `${project.subdomain}.${project.baseDomain}` === host;
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/services/__tests__/tlsCheck.service.test.ts`
Expected: PASS — all five tests green.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/tlsCheck.service.ts server/src/services/__tests__/tlsCheck.service.test.ts
git commit -m "feat: TlsCheckService — gate on-demand certs to live preview hostnames"
```

---

## Task 4: `tls-check` internal route + mount

**Files:**
- Create: `server/src/routes/internal.routes.ts`
- Modify: `server/src/index.ts`

- [ ] **Step 1: Create the internal router**

Create `server/src/routes/internal.routes.ts`:
```ts
import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { TlsCheckService } from '../services/tlsCheck.service';

const router = Router();

// Called server-side by Caddy's on_demand_tls `ask`. Unauthenticated by
// necessity, but rate-limited so it can't be used to probe hostnames or DoS.
const tlsCheckLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
});

// Caddy issues a cert only if this returns 2xx.
router.get('/tls-check', tlsCheckLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const domain = (req.query.domain as string) || '';
        const ok = await TlsCheckService.isLivePreviewHostname(domain);
        if (ok) {
            res.status(200).send('ok');
        } else {
            res.status(404).send('unknown host');
        }
    } catch (error) {
        next(error);
    }
});

export default router;
```

- [ ] **Step 2: Mount it outside the auth chain**

In `server/src/index.ts`, add the import alongside the other route imports:
```ts
import internalRoutes from './routes/internal.routes';
```
Then mount it next to the other unauthenticated router (`webhookRoutes`). After the line `app.use('/api/webhooks', webhookRoutes);` add:
```ts
    app.use('/api/internal', internalRoutes);
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no output, exit 0.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS — all test files (smoke, migrations, preview.helpers, preview.service, serverConfig.service, tlsCheck.service).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/internal.routes.ts server/src/index.ts
git commit -m "feat: mount unauthenticated /api/internal/tls-check route"
```

---

## Task 5: Caddyfile `on_demand_tls` + operator docs

**Files:**
- Modify: `setup.sh`

- [ ] **Step 1: Add the global on_demand_tls block**

In `setup.sh`, in the master Caddyfile heredoc (the `cat > /etc/caddy/Caddyfile <<EOF ...`), change the global options block from:
```
{
    admin localhost:2019
    email ${ADMIN_EMAIL}
}
```
to:
```
{
    admin localhost:2019
    email ${ADMIN_EMAIL}

    # Preview environments use on-demand TLS; Caddy asks the API before
    # issuing a cert so only live preview hostnames get one.
    on_demand_tls {
        ask http://localhost:3001/api/internal/tls-check
    }
}
```

- [ ] **Step 2: Add the operator doc line to the completion banner**

In `setup.sh`, find the completion banner (the block that prints post-install instructions near the end — it already prints OAuth callback URLs). Add a line about the wildcard DNS record for previews. Locate an `echo` in that banner and add after it:
```bash
echo "  • PR previews (optional): point a wildcard DNS record"
echo "      *.preview.${DOMAIN}  →  this server's IP"
echo "    then set the preview base domain to 'preview.${DOMAIN}' per project."
```
(If the banner uses a different echo style/variable, match it; the content above is what must be conveyed.)

- [ ] **Step 3: Syntax-check the script**

Run (repo root): `bash -n setup.sh`
Expected: no output, exit 0.

- [ ] **Step 4: Commit**

```bash
git add setup.sh
git commit -m "feat: Caddy on_demand_tls block + preview wildcard DNS docs"
```

---

## Task 6: Phase 3 verification

**Files:** none.

- [ ] **Step 1: Tests** — Run (server/): `npm test` → PASS (6 test files).
- [ ] **Step 2: Type-check** — Run (server/): `npx tsc --noEmit` → exit 0.
- [ ] **Step 3: Build** — Run (server/): `npm run build` → exit 0.
- [ ] **Step 4: Script syntax** — Run (repo root): `bash -n setup.sh` → exit 0.
- [ ] **Step 5: Clean tree** — Run (repo root): `git status --short` → empty.

---

## Phase 3 Done — Next

After Phase 3, a preview that is enabled and deployed is reachable over HTTPS at `<derived-subdomain>.<previewBaseDomain>`. The remaining gap is the **enable path + visibility**: there is still no UI to turn previews on for a project (so `handlePullRequest` still returns `previews-disabled`), no Previews tab, and no TTL reaper. **Phase 4** adds the Settings "PR Previews" card (which also calls `GithubService.ensureWebhookEvents` to upgrade an existing push-only webhook), the Previews tab + list/destroy routes, the dashboard wiring, and the TTL sweep in the monitor.

---

## Self-Review Notes

- **Spec coverage (Phase 3 slice):** `ServerConfigOptions` `baseDomain`/`onDemandTls` ✓ (Task 1); override scoped to the Caddy generator only ✓ (Task 1, Nginx/Apache untouched); call sites threaded ✓ (Task 2); `tls-check` returns 200 only for live preview hostnames ✓ (Task 3); separate unauthenticated rate-limited router mounted outside auth ✓ (Task 4); Caddyfile `on_demand_tls` + wildcard DNS docs ✓ (Task 5).
- **Type consistency:** `TlsCheckService.isLivePreviewHostname(domain)` defined (Task 3) and used (Task 4) identically; `ServerConfigOptions` fields `baseDomain`/`onDemandTls` referenced consistently across the generator (Task 1) and all three call sites (Task 2).
- **No placeholders:** every code step is complete; run steps have exact commands + expected output.
- **Security check:** `tls-check` only ever returns a boolean for a hostname lookup, filters `isPreview: true`, verifies the full `<subdomain>.<baseDomain>` matches the stored value (so it can't authorize arbitrary domains), and is rate-limited — consistent with the spec's intent. It is mounted outside `authenticate` (like `webhookRoutes`) because Caddy calls it server-side.
- **Behavior preservation:** for non-preview projects `baseDomain` is undefined → generator falls back to `config.hosting.baseDomain` (unchanged output) and `onDemandTls` is false → no `tls` block (unchanged output). The Task 1 "normal project" test asserts this.
