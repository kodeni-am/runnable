import { describe, it, expect, vi, beforeEach } from 'vitest';

const domainFindOne = vi.fn();
const projectFindOne = vi.fn();
const projectFind = vi.fn();
const save = vi.fn(async (x: any) => x);
const create = vi.fn((x: any) => x);
vi.mock('../../config/data-source', () => ({
    AppDataSource: {
        getRepository: (entity: any) =>
            entity?.name === 'Project'
                ? { findOne: projectFindOne, find: projectFind }
                : { findOne: domainFindOne, save, create },
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
import { DomainService, isWildcardDomain, wildcardApex } from '../domain.service';

const CERT = '/etc/caddy/certs/moments.am.origin.pem';
const KEY = '/etc/caddy/certs/moments.am.origin.key';
const wildcardOpts = { tlsCertPath: CERT, tlsKeyPath: KEY, isAdmin: true };

beforeEach(() => {
    vi.clearAllMocks();
    domainFindOne.mockResolvedValue(null);
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

describe('verifyDomain', () => {
    it('verifies a wildcard by TXT at the apex and never by CNAME', async () => {
        domainFindOne.mockResolvedValue({ id: 'd-1', domain: '*.moments.am', project: { id: 'p-1', subdomain: 'moments' } });
        projectFindOne.mockResolvedValue(null);
        resolveTxt.mockResolvedValue([['p-1']]);
        expect(await DomainService.verifyDomain('d-1', 'p-1')).toBe(true);
        expect(resolveTxt).toHaveBeenCalledWith('_runnable-verify.moments.am');
        expect(resolveCname).not.toHaveBeenCalled();
    });
});

describe('helpers', () => {
    it('detects wildcards and returns their apex', () => {
        expect(isWildcardDomain('*.moments.am')).toBe(true);
        expect(isWildcardDomain('moments.am')).toBe(false);
        expect(wildcardApex('*.moments.am')).toBe('moments.am');
    });
});
