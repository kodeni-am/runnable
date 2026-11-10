import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { buildProxyOptions } from '../proxyOptions';
import { defaultCertCheckDeps, hasPermission, resolveUser, wildcardCertProblem, type CertCheckDeps, type StatLike } from '../certCheck';
import { ServerType } from '../../entities';

// Self-signed test-only fixtures; *.example.com valid until 2126, expired copy 2020-2021, *.other.org with its own key.
const FIX = path.join(__dirname, 'fixtures', 'certs');
const CERT = path.join(FIX, 'wildcard-example.pem');
const KEY = path.join(FIX, 'wildcard-example.key');
const EXPIRED = path.join(FIX, 'wildcard-example-expired.pem');
const OTHER_HOST = path.join(FIX, 'wildcard-other.pem');
const OTHER_KEY = path.join(FIX, 'other.key');

const PASSWD = 'root:x:0:0:root:/root:/bin/bash\ncaddy:x:998:997:Caddy:/var/lib/caddy:/usr/sbin/nologin\n';
const GROUP = 'root:x:0:\ncaddy:x:997:\nssl-cert:x:110:caddy,www-data\n';

/** Deps with no caddy user (permission check skipped), real files. */
const noCaddy: CertCheckDeps = { ...defaultCertCheckDeps, readPasswd: async () => null, readGroup: async () => null };

/** Deps with a caddy user and a fake stat: dirs root:caddy 0750, files per `fileStat`. */
function withCaddy(fileStat: StatLike, dirStat: StatLike = { mode: 0o40750, uid: 0, gid: 997 }): CertCheckDeps {
    return {
        ...defaultCertCheckDeps,
        readPasswd: async () => PASSWD,
        readGroup: async () => GROUP,
        realpath: async (p) => p,
        stat: async (p) => (p === CERT || p === KEY ? fileStat : dirStat),
    };
}

const project = { subdomain: 'ex', directoryPath: '/srv/ex', serverType: ServerType.APP, port: 4100 } as any;
const wildcardRow = (cert: string, key: string) => ({ domain: '*.example.com', redirectTarget: null, tlsCertPath: cert, tlsKeyPath: key });

afterEach(() => vi.restoreAllMocks());

describe('wildcardCertProblem', () => {
    it('accepts a valid pair', async () => {
        expect(await wildcardCertProblem('*.example.com', CERT, KEY, noCaddy)).toBeNull();
    });

    it('accepts a chain (leaf first)', async () => {
        const chain = fs.readFileSync(CERT, 'utf8') + fs.readFileSync(OTHER_HOST, 'utf8');
        const deps = { ...noCaddy, readFile: async (p: string) => (p === CERT ? chain : fs.readFileSync(p, 'utf8')) };
        expect(await wildcardCertProblem('*.example.com', CERT, KEY, deps)).toBeNull();
    });

    it('rejects a mismatched key', async () => {
        expect(await wildcardCertProblem('*.example.com', CERT, OTHER_KEY, noCaddy)).toMatch(/does not match/);
    });

    it('rejects an expired certificate', async () => {
        expect(await wildcardCertProblem('*.example.com', EXPIRED, KEY, noCaddy)).toMatch(/expired/);
    });

    it('rejects a certificate for another host', async () => {
        expect(await wildcardCertProblem('*.example.com', OTHER_HOST, OTHER_KEY, noCaddy)).toMatch(/does not cover/);
    });

    it('rejects garbage PEM in either file', async () => {
        const garbage = { ...noCaddy, readFile: async () => '-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----\n' };
        expect(await wildcardCertProblem('*.example.com', CERT, KEY, garbage)).toMatch(/not a valid PEM certificate/);
        const badKey = { ...noCaddy, readFile: async (p: string) => (p === KEY ? 'garbage' : fs.readFileSync(p, 'utf8')) };
        expect(await wildcardCertProblem('*.example.com', CERT, KEY, badKey)).toMatch(/private key/);
    });

    it('rejects a missing file', async () => {
        expect(await wildcardCertProblem('*.example.com', path.join(FIX, 'missing.pem'), KEY, noCaddy)).toMatch(/unreadable/);
    });

    it('rejects a file the caddy user cannot read (0600 root)', async () => {
        const deps = withCaddy({ mode: 0o100600, uid: 0, gid: 0 });
        expect(await wildcardCertProblem('*.example.com', CERT, KEY, deps)).toMatch(/caddy cannot read/);
    });

    it('rejects a parent directory the caddy user cannot traverse', async () => {
        const deps = withCaddy({ mode: 0o100640, uid: 0, gid: 997 }, { mode: 0o40700, uid: 0, gid: 0 });
        expect(await wildcardCertProblem('*.example.com', CERT, KEY, deps)).toMatch(/caddy cannot traverse/);
    });

    it('accepts root:caddy 0640 files under root:caddy 0750 dirs', async () => {
        const deps = withCaddy({ mode: 0o100640, uid: 0, gid: 997 });
        expect(await wildcardCertProblem('*.example.com', CERT, KEY, deps)).toBeNull();
    });

    it('skips the permission check when there is no caddy user', async () => {
        const stat = vi.fn(async () => ({ mode: 0o100600, uid: 0, gid: 0 }));
        const deps = { ...noCaddy, readPasswd: async () => 'root:x:0:0:root:/root:/bin/bash\n', stat };
        expect(await wildcardCertProblem('*.example.com', CERT, KEY, deps)).toBeNull();
        expect(stat).not.toHaveBeenCalled();
    });
});

describe('resolveUser / hasPermission', () => {
    it('collects primary and supplementary groups', () => {
        expect(resolveUser('caddy', PASSWD, GROUP)).toEqual({ uid: 998, gids: [997, 110] });
        expect(resolveUser('nobody', PASSWD, GROUP)).toBeNull();
    });

    it('uses owner, then group, then other bits', () => {
        const who = { uid: 998, gids: [997] };
        expect(hasPermission({ mode: 0o040, uid: 998, gid: 997 }, who, 4)).toBe(false); // owner match wins, u-r
        expect(hasPermission({ mode: 0o040, uid: 0, gid: 997 }, who, 4)).toBe(true);
        expect(hasPermission({ mode: 0o004, uid: 0, gid: 997 }, who, 4)).toBe(false); // group match wins, g-r
        expect(hasPermission({ mode: 0o004, uid: 0, gid: 0 }, who, 4)).toBe(true);
        expect(hasPermission({ mode: 0o001, uid: 0, gid: 0 }, who, 1)).toBe(true);
    });
});

describe('buildProxyOptions wildcard validation', () => {
    it('keeps a valid wildcard and maps tls', async () => {
        const opts = await buildProxyOptions(project, [wildcardRow(CERT, KEY)] as any, {}, noCaddy);
        expect(opts.customDomains).toEqual([{ domain: '*.example.com', redirectTarget: null, tls: { cert: CERT, key: KEY } }]);
    });

    it.each([
        ['a mismatched key', CERT, OTHER_KEY, noCaddy],
        ['an expired certificate', EXPIRED, KEY, noCaddy],
        ['a certificate for another host', OTHER_HOST, OTHER_KEY, noCaddy],
        ['a file caddy cannot read', CERT, KEY, withCaddy({ mode: 0o100600, uid: 0, gid: 0 })],
    ])('drops a wildcard with %s and warns', async (_label, cert, key, deps) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const opts = await buildProxyOptions(
            project,
            [{ domain: 'example.com', verified: true, redirectTarget: null }, wildcardRow(cert, key)] as any,
            {},
            deps,
        );
        expect(opts.customDomains).toEqual([{ domain: 'example.com', redirectTarget: null }]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('*.example.com'));
    });

    it('drops a wildcard with garbage PEM', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const deps = { ...noCaddy, readFile: async () => 'garbage' };
        const opts = await buildProxyOptions(project, [wildcardRow(CERT, KEY)] as any, {}, deps);
        expect(opts.customDomains).toEqual([]);
    });
});
