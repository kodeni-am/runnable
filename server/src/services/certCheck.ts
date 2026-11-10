import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * Checks a supplied wildcard certificate the way Caddy will meet it: Caddy runs
 * as the `caddy` user (Runnable runs as root, so a plain fs.access proves
 * nothing) and refuses the whole reload if any site's cert cannot be loaded.
 */

export interface StatLike {
    mode: number;
    uid: number;
    gid: number;
}

export interface CertCheckDeps {
    readFile: (p: string) => Promise<string>;
    stat: (p: string) => Promise<StatLike>;
    realpath: (p: string) => Promise<string>;
    /** Contents of /etc/passwd and /etc/group, or null when unavailable. */
    readPasswd: () => Promise<string | null>;
    readGroup: () => Promise<string | null>;
    now: () => Date;
    /** The user Caddy runs as. */
    caddyUser: string;
}

async function readOrNull(p: string): Promise<string | null> {
    try {
        return await fs.promises.readFile(p, 'utf8');
    } catch {
        return null;
    }
}

export const defaultCertCheckDeps: CertCheckDeps = {
    readFile: (p) => fs.promises.readFile(p, 'utf8'),
    stat: (p) => fs.promises.stat(p),
    realpath: (p) => fs.promises.realpath(p),
    readPasswd: () => readOrNull('/etc/passwd'),
    readGroup: () => readOrNull('/etc/group'),
    now: () => new Date(),
    caddyUser: 'caddy',
};

export interface UserIdentity {
    uid: number;
    gids: number[];
}

/** Resolve a user's uid, primary gid and supplementary groups; null if the user does not exist. */
export function resolveUser(name: string, passwd: string | null, group: string | null): UserIdentity | null {
    if (!passwd) return null;
    const entry = passwd.split('\n').map(l => l.split(':')).find(f => f[0] === name && f.length >= 4);
    if (!entry) return null;
    const uid = Number(entry[2]);
    const primary = Number(entry[3]);
    if (!Number.isInteger(uid) || !Number.isInteger(primary)) return null;
    const gids = new Set<number>([primary]);
    for (const line of (group || '').split('\n')) {
        const f = line.split(':');
        if (f.length < 4) continue;
        const members = f[3].trim().split(',').map(m => m.trim()).filter(Boolean);
        const gid = Number(f[2]);
        if (members.includes(name) && Number.isInteger(gid)) gids.add(gid);
    }
    return { uid, gids: [...gids] };
}

/** POSIX permission check for one bit (4 = read, 1 = execute/traverse): owner, else group, else other. */
export function hasPermission(st: StatLike, who: UserIdentity, bit: 4 | 1): boolean {
    if (who.uid === 0) return true;
    if (st.uid === who.uid) return (st.mode & (bit << 6)) !== 0;
    if (who.gids.includes(st.gid)) return (st.mode & (bit << 3)) !== 0;
    return (st.mode & bit) !== 0;
}

function parentDirs(p: string): string[] {
    const dirs: string[] = [];
    let dir = path.dirname(p);
    for (;;) {
        dirs.push(dir);
        const up = path.dirname(dir);
        if (up === dir) break;
        dir = up;
    }
    return dirs;
}

/** Returns why `who` cannot read the file, or null when it can. */
async function readableBy(file: string, who: UserIdentity, deps: CertCheckDeps): Promise<string | null> {
    // Walk the path as given and its symlink-resolved form: Caddy needs both.
    const real = await deps.realpath(file).catch(() => file);
    const dirs = new Set([...parentDirs(file), ...parentDirs(real)]);
    for (const dir of dirs) {
        if (!hasPermission(await deps.stat(dir), who, 1)) {
            return `${deps.caddyUser} cannot traverse ${dir}`;
        }
    }
    if (!hasPermission(await deps.stat(real), who, 4)) {
        return `${deps.caddyUser} cannot read ${file}`;
    }
    return null;
}

/**
 * Returns the reason a wildcard's certificate would fail in Caddy, or null if
 * it is usable: both files parse, the key matches, the cert is unexpired and
 * covers a host under the apex, and the caddy user can read both files.
 */
export async function wildcardCertProblem(
    domain: string,
    certPath: string,
    keyPath: string,
    deps: CertCheckDeps = defaultCertCheckDeps,
): Promise<string | null> {
    let certPem: string;
    let keyPem: string;
    try {
        certPem = await deps.readFile(certPath);
        keyPem = await deps.readFile(keyPath);
    } catch (err: any) {
        return `certificate or key unreadable (${err?.message || err})`;
    }

    let cert: crypto.X509Certificate;
    let key: crypto.KeyObject;
    try {
        cert = new crypto.X509Certificate(certPem); // a chain parses to its first (leaf) cert
    } catch {
        return 'certificate is not a valid PEM certificate';
    }
    try {
        key = crypto.createPrivateKey(keyPem);
    } catch {
        return 'key is not a valid unencrypted PEM private key';
    }
    if (!cert.checkPrivateKey(key)) {
        return 'key does not match the certificate';
    }
    if (new Date(cert.validTo).getTime() <= deps.now().getTime()) {
        return `certificate expired on ${cert.validTo}`;
    }
    const apex = domain.replace(/^\*\./, '');
    if (!cert.checkHost(`x.${apex}`)) {
        return `certificate does not cover ${domain}`;
    }

    let who: UserIdentity | null;
    try {
        who = resolveUser(deps.caddyUser, await deps.readPasswd(), await deps.readGroup());
    } catch {
        who = null;
    }
    if (!who) return null; // no caddy user on this host (dev, macOS): skip the permission check

    try {
        return (await readableBy(certPath, who, deps)) ?? (await readableBy(keyPath, who, deps));
    } catch (err: any) {
        return `cannot check file permissions (${err?.message || err})`;
    }
}
