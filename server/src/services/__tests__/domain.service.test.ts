import { describe, it, expect, vi, beforeEach } from 'vitest';

const domainFindOne = vi.fn();
const domainFind = vi.fn();
const projectFindOne = vi.fn();
const projectFind = vi.fn();
const save = vi.fn(async (x: any) => x);
const create = vi.fn((x: any) => x);
vi.mock('../../config/data-source', () => ({
    AppDataSource: {
        getRepository: (entity: any) =>
            entity?.name === 'Project'
                ? { findOne: projectFindOne, find: projectFind }
                : { findOne: domainFindOne, find: domainFind, save, create },
    },
}));

vi.mock('../serverConfig.service', () => ({
    ServerConfigService: {
        generateConfig: vi.fn(async () => ''),
        writeConfig: vi.fn(async () => ''),
        reloadCaddy: vi.fn(async () => { }),
    },
}));
vi.mock('../process.service', () => ({ ProcessService: {} }));

const resolveCname = vi.fn();
const resolveTxt = vi.fn();
vi.mock('dns/promises', () => ({
    default: {
        resolveCname: (...a: any[]) => (resolveCname as any)(...a),
        resolveTxt: (...a: any[]) => (resolveTxt as any)(...a),
    },
}));

import { config } from '../../config';
import { ServerConfigService } from '../serverConfig.service';
import { DomainService, isWildcardDomain, wildcardApex, wildcardCovers } from '../domain.service';

const CERT = '/etc/caddy/certs/moments.am.origin.pem';
const KEY = '/etc/caddy/certs/moments.am.origin.key';
const wildcardOpts = { tlsCertPath: CERT, tlsKeyPath: KEY, isAdmin: true };

beforeEach(() => {
    vi.clearAllMocks();
    domainFindOne.mockResolvedValue(null);
    domainFind.mockResolvedValue([]);
    projectFind.mockResolvedValue([]);
    projectFindOne.mockResolvedValue({ id: 'p-1', subdomain: 'moments' });
});

describe('addDomain', () => {
    it('lower-cases the domain before storing', async () => {
        const { domain } = await DomainService.addDomain('p-1', 'Moments.AM');
        expect(domain.domain).toBe('moments.am');
        expect(domainFindOne).toHaveBeenCalledWith({ where: { domain: 'moments.am' } });
    });

    it('accepts a single leading wildcard label', async () => {
        const { domain } = await DomainService.addDomain('p-1', '*.moments.am', wildcardOpts);
        expect(domain).toMatchObject({ domain: '*.moments.am', tlsCertPath: CERT, tlsKeyPath: KEY });
        expect(save).toHaveBeenCalled();
    });

    it('rejects wildcards without both cert paths', async () => {
        for (const opts of [
            { isAdmin: true },
            { isAdmin: true, tlsCertPath: CERT },
            { isAdmin: true, tlsKeyPath: KEY },
        ]) {
            await expect(DomainService.addDomain('p-1', '*.moments.am', opts)).rejects.toMatchObject({ statusCode: 400 });
        }
    });

    it('rejects wildcards from non-admins', async () => {
        await expect(
            DomainService.addDomain('p-1', '*.moments.am', { ...wildcardOpts, isAdmin: false }),
        ).rejects.toMatchObject({ statusCode: 403 });
    });

    it('rejects a redirect target on a wildcard', async () => {
        await expect(
            DomainService.addDomain('p-1', '*.moments.am', { ...wildcardOpts, redirectTarget: 'example.com' }),
        ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('rejects wildcards covering the hosting base domain', async () => {
        await expect(
            DomainService.addDomain('p-1', `*.${config.hosting.baseDomain}`, wildcardOpts),
        ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("rejects wildcards covering a project's previewBaseDomain", async () => {
        projectFind.mockResolvedValue([{ previewBaseDomain: 'preview.moments.am' }]);
        await expect(
            DomainService.addDomain('p-1', '*.preview.moments.am', wildcardOpts),
        ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('rejects nested or mid-label wildcards', async () => {
        for (const d of ['*.*.moments.am', 'a.*.moments.am', '*moments.am']) {
            await expect(DomainService.addDomain('p-1', d, wildcardOpts)).rejects.toMatchObject({ statusCode: 400 });
        }
    });

    it('rejects cert paths that are relative or contain unsafe characters', async () => {
        for (const bad of ['certs/a.pem', '/etc/a b.pem', '/etc/a;rm.pem', '/etc/a\n.pem', '/etc/{x}.pem']) {
            await expect(
                DomainService.addDomain('p-1', '*.moments.am', { ...wildcardOpts, tlsCertPath: bad }),
            ).rejects.toMatchObject({ statusCode: 400 });
        }
    });

    it('rejects cert paths with a parent segment', async () => {
        for (const bad of ['/etc/caddy/../shadow', '/etc/caddy/certs/..', '/../etc/a.pem']) {
            await expect(
                DomainService.addDomain('p-1', '*.moments.am', { ...wildcardOpts, tlsKeyPath: bad }),
            ).rejects.toMatchObject({ statusCode: 400 });
        }
    });

    it('rejects non-string cert paths', async () => {
        for (const bad of [123, ['/etc/a.pem'], { a: 1 }, true]) {
            await expect(
                DomainService.addDomain('p-1', '*.moments.am', { ...wildcardOpts, tlsCertPath: bad as any }),
            ).rejects.toMatchObject({ statusCode: 400 });
        }
    });
});

describe('addDomain — no takeover across projects', () => {
    const rows = (list: { domain: string; projectId: string }[]) => {
        domainFindOne.mockImplementation(async ({ where }: any) => list.find(r => r.domain === where.domain) ?? null);
        domainFind.mockResolvedValue(list);
    };

    it("rejects an exact domain under another project's wildcard", async () => {
        rows([{ domain: '*.moments.am', projectId: 'p-other' }]);
        await expect(DomainService.addDomain('p-1', 'anna.moments.am')).rejects.toMatchObject({
            statusCode: 400,
            message: expect.stringContaining('*.moments.am'),
        });
        expect(save).not.toHaveBeenCalled();
    });

    it('allows an exact domain two labels under the wildcard (Caddy covers one label)', async () => {
        rows([{ domain: '*.moments.am', projectId: 'p-other' }]);
        await expect(DomainService.addDomain('p-1', 'a.b.moments.am')).resolves.toBeDefined();
    });

    it("rejects a wildcard while another project owns an exact domain it covers", async () => {
        rows([{ domain: 'anna.moments.am', projectId: 'p-other' }]);
        await expect(DomainService.addDomain('p-1', '*.moments.am', wildcardOpts)).rejects.toMatchObject({
            statusCode: 400,
            message: expect.stringContaining('anna.moments.am'),
        });
        expect(save).not.toHaveBeenCalled();
    });

    it('matches a legacy mixed-case exact domain on another project', async () => {
        rows([{ domain: 'Anna.Moments.AM', projectId: 'p-other' }]);
        await expect(DomainService.addDomain('p-1', '*.moments.am', wildcardOpts)).rejects.toMatchObject({ statusCode: 400 });
        expect(domainFind.mock.calls[0][0].where.domain.type).toBe('ilike');
    });

    it('ignores other-project domains the wildcard does not cover', async () => {
        rows([
            { domain: 'moments.am', projectId: 'p-other' },
            { domain: 'a.b.moments.am', projectId: 'p-other' },
            { domain: 'anna.notmoments.am', projectId: 'p-other' },
        ]);
        await expect(DomainService.addDomain('p-1', '*.moments.am', wildcardOpts)).resolves.toBeDefined();
    });

    it('allows exact and wildcard on the same project, in either order', async () => {
        rows([{ domain: '*.moments.am', projectId: 'p-1' }]);
        await expect(DomainService.addDomain('p-1', 'www.moments.am')).resolves.toBeDefined();
        rows([{ domain: 'www.moments.am', projectId: 'p-1' }]);
        await expect(DomainService.addDomain('p-1', '*.moments.am', wildcardOpts)).resolves.toBeDefined();
    });
});

describe('setRedirectTarget', () => {
    it('rejects a wildcard row', async () => {
        domainFindOne.mockResolvedValue({ id: 'd-1', domain: '*.moments.am', projectId: 'p-1', project: { id: 'p-1' } });
        for (const target of ['example.com', null]) {
            await expect(DomainService.setRedirectTarget('d-1', 'p-1', target)).rejects.toMatchObject({ statusCode: 400 });
        }
        expect(save).not.toHaveBeenCalled();
    });
});

describe('verifyDomain', () => {
    it('verifies a wildcard by TXT at the apex and never by CNAME', async () => {
        domainFindOne.mockResolvedValue({ id: 'd-1', domain: '*.moments.am', project: { id: 'p-1', subdomain: 'moments' } });
        projectFindOne.mockResolvedValue(null);
        resolveTxt.mockResolvedValue([['p-1']]);
        expect(await DomainService.verifyDomain('d-1', 'p-1')).toBe(true);
        expect(resolveTxt).toHaveBeenCalledWith('_runnable-verify.moments.am');
        expect(resolveCname).not.toHaveBeenCalled();
    });

    // The row the DB hands back is the same object verifyDomain flips, so the
    // regenerated config sees the domain only because it is now verified.
    function regularDomainFixture() {
        const row: any = { id: 'd-2', domain: 'example.org', verified: false, redirectTarget: null, tlsCertPath: null, tlsKeyPath: null, projectId: 'p-1' };
        const project = { id: 'p-1', subdomain: 'moments', directoryPath: '/srv/m', serverType: 'app', port: 4100, customDomains: [row] };
        row.project = project;
        domainFindOne.mockResolvedValue(row);
        projectFindOne.mockResolvedValue(project);
        return row;
    }

    it('regenerates the config with a regular domain once its CNAME verifies', async () => {
        const row = regularDomainFixture();
        resolveCname.mockResolvedValue([`moments.${config.hosting.baseDomain}`]);
        expect(await DomainService.verifyDomain('d-2', 'p-1')).toBe(true);
        expect(row.verified).toBe(true);
        expect(ServerConfigService.generateConfig).toHaveBeenCalledWith(expect.objectContaining({
            customDomains: [{ domain: 'example.org', redirectTarget: null }],
        }));
        expect(ServerConfigService.writeConfig).toHaveBeenCalledWith('moments', '', 'app');
        expect(ServerConfigService.reloadCaddy).toHaveBeenCalled();
    });

    it('regenerates the config with a regular domain once its TXT verifies', async () => {
        regularDomainFixture();
        resolveCname.mockRejectedValue(new Error('ENODATA'));
        resolveTxt.mockResolvedValue([['p-1']]);
        expect(await DomainService.verifyDomain('d-2', 'p-1')).toBe(true);
        expect(resolveTxt).toHaveBeenCalledWith('_runnable-verify.example.org');
        expect(ServerConfigService.generateConfig).toHaveBeenCalledWith(expect.objectContaining({
            customDomains: [{ domain: 'example.org', redirectTarget: null }],
        }));
        expect(ServerConfigService.reloadCaddy).toHaveBeenCalled();
    });

    it('leaves the domain unverified and the config untouched when DNS does not match', async () => {
        const row = regularDomainFixture();
        resolveCname.mockResolvedValue(['elsewhere.example.net']);
        resolveTxt.mockResolvedValue([['someone-else']]);
        expect(await DomainService.verifyDomain('d-2', 'p-1')).toBe(false);
        expect(row.verified).toBe(false);
        expect(ServerConfigService.generateConfig).not.toHaveBeenCalled();
        expect(ServerConfigService.reloadCaddy).not.toHaveBeenCalled();
    });
});

describe('helpers', () => {
    it('detects wildcards and returns their apex', () => {
        expect(isWildcardDomain('*.moments.am')).toBe(true);
        expect(isWildcardDomain('moments.am')).toBe(false);
        expect(wildcardApex('*.moments.am')).toBe('moments.am');
    });

    it('a wildcard covers exactly one label', () => {
        expect(wildcardCovers('*.moments.am', 'anna.moments.am')).toBe(true);
        expect(wildcardCovers('*.moments.am', 'moments.am')).toBe(false);
        expect(wildcardCovers('*.moments.am', 'a.b.moments.am')).toBe(false);
        expect(wildcardCovers('*.moments.am', 'annamoments.am')).toBe(false);
        expect(wildcardCovers('*.moments.am', '*.moments.am')).toBe(false);
    });
});
