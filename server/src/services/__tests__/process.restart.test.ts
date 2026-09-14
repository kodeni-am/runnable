import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';

// The build log lives at <servDir>/../logs — point it at a scratch tree so
// tests never touch /var/runnable.
const { TMP } = vi.hoisted(() => {
    const fsSync = require('fs');
    const os = require('os');
    const p = require('path');
    const TMP = fsSync.mkdtempSync(p.join(os.tmpdir(), 'process-restart-'));
    fsSync.mkdirSync(p.join(TMP, 'projects'), { recursive: true });
    return { TMP };
});

vi.mock('../../config', async (importOriginal) => {
    const real: any = await importOriginal();
    return { config: { ...real.config, hosting: { ...real.config.hosting, servDir: path.join(TMP, 'projects') } } };
});

const findOne = vi.fn();
const save = vi.fn(async (p: any) => p);
const update = vi.fn(async () => undefined);
const getRawOne = vi.fn(async () => null);
vi.mock('../../config/data-source', () => ({
    AppDataSource: {
        getRepository: () => ({
            findOne, save, update,
            createQueryBuilder: () => ({ select: () => ({ where: () => ({ getRawOne }) }) }),
        }),
    },
}));

type ExecResult = { stdout: string; stderr: string; exitCode: number };
const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0 });
const fail = (stderr = ''): ExecResult => ({ stdout: '', stderr, exitCode: 1 });

/** Whether `docker image inspect runnable-img-*` reports the image present. */
let imageExists = true;

const exec = vi.fn(async (_projectId: string, cmd: string, args: string[]): Promise<ExecResult> => {
    const joined = `${cmd} ${args.join(' ')}`;
    if (/^docker image inspect/.test(joined)) return imageExists ? ok('sha256:img') : fail('No such image');
    if (/^docker inspect --format {{.State.Status}}/.test(joined)) return ok('running\n');
    if (/^docker port /.test(joined)) return ok('0.0.0.0:32768\n');
    if (/^docker ps -a --filter name=/.test(joined)) return ok('');
    if (/^docker ps -q --filter label=/.test(joined)) return ok('ctr-1\n');
    if (/^docker compose .* config$/.test(joined)) {
        return ok('services:\n  web:\n    image: web\n    ports:\n      - "${PORT}:8080"\n');
    }
    if (/^docker compose .* port web 8080$/.test(joined)) return ok('0.0.0.0:32768\n');
    return ok('');
});
const spawn = vi.fn(async () => 0);
vi.mock('../sandbox.service', () => ({
    SandboxService: {
        exec: (...a: any[]) => (exec as any)(...a),
        spawn: (...a: any[]) => (spawn as any)(...a),
    },
}));

vi.mock('../serverConfig.service', () => ({
    ServerConfigService: {
        generateConfig: vi.fn(async () => 'cfg'),
        writeConfig: vi.fn(async () => path.join(TMP, 'proxy.conf')),
        removeConfig: vi.fn(async () => undefined),
        reloadCaddy: vi.fn(async () => undefined),
    },
}));

vi.mock('../detect.service', () => ({
    DetectService: { detect: vi.fn(async () => ({ runtime: 'node', useCompose: false })) },
}));

vi.mock('../composePolicy.service', () => ({
    ComposePolicyService: { validateRawReferences: () => undefined, validate: () => undefined },
}));

vi.mock('../buildCache.service', () => ({
    BuildCacheService: { enforceCap: vi.fn(async () => undefined) },
}));

vi.mock('../healthMonitor.service', () => ({
    HealthMonitorService: { isContainerRunning: vi.fn(async () => true), reset: vi.fn() },
}));

import { ProcessService } from '../process.service';

const PROJECT_ID = 'abcdef12-0000-0000-0000-000000000000';
const IMAGE = 'runnable-img-abcdef12';
const CONTAINER = 'runnable-abcdef12';

let project: any;
let dir: string;

function railpackProject() {
    return {
        id: PROJECT_ID, name: 'Api', subdomain: 'api', serverType: 'app', status: 'running',
        directoryPath: dir, containerId: CONTAINER, port: 32000, internalPort: 8080,
        envVars: { API_KEY: 'new-value' }, customDomains: [],
    };
}

function composeProject() {
    return {
        ...railpackProject(),
        useCompose: true, composeFile: 'docker-compose.yml', composeService: 'web',
    };
}

/** Every `docker <verb> ...` invocation, as joined strings, across exec and spawn. */
const dockerCalls = () => [
    ...exec.mock.calls.map(([, cmd, args]: any) => `${cmd} ${args.join(' ')}`),
    ...spawn.mock.calls.map(([, cmd, args]: any) => `${cmd} ${args.join(' ')}`),
];
const railpackBuilds = () => spawn.mock.calls.filter(([, cmd]: any) => cmd === 'railpack');
const composeUps = () => spawn.mock.calls
    .map(([, cmd, args]: any) => `${cmd} ${args.join(' ')}`)
    .filter(s => /^docker compose .* up /.test(s));
/** The `docker run` of the app image (not BuildKit's daemon container). */
const dockerRun = () => exec.mock.calls
    .map(([, cmd, args]: any) => ({ cmd, args }))
    .find(({ cmd, args }) => cmd === 'docker' && args[0] === 'run' && args.includes(IMAGE));

beforeEach(async () => {
    vi.clearAllMocks();
    imageExists = true;
    dir = await fs.mkdtemp(path.join(TMP, 'proj-'));
    await fs.writeFile(path.join(dir, 'docker-compose.yml'), 'services:\n  web:\n    image: web\n');
    project = railpackProject();
    findOne.mockImplementation(async () => project);
});

afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
});

describe('restart (single container)', () => {
    it('reuses the existing image and passes the current env vars to the new container', async () => {
        await ProcessService.restart(PROJECT_ID);

        expect(railpackBuilds()).toHaveLength(0);
        const run = dockerRun();
        expect(run).toBeDefined();
        expect(run!.args).toContain(IMAGE);
        expect(run!.args).toContain('API_KEY=new-value');
        expect(project.status).toBe('running');
    });

    it('records in the build log that the image was reused', async () => {
        await ProcessService.restart(PROJECT_ID);
        const log = await fs.readFile(path.join(TMP, 'logs', 'api-build.log'), 'utf-8');
        expect(log).toMatch(/reusing existing image/i);
    });

    it('falls back to a full build when no image exists', async () => {
        imageExists = false;
        await ProcessService.restart(PROJECT_ID);

        expect(railpackBuilds()).toHaveLength(1);
        expect(dockerRun()).toBeDefined();
    });
});

describe('rebuild (single container)', () => {
    it('builds the image even when one already exists', async () => {
        await ProcessService.rebuild(PROJECT_ID);

        expect(railpackBuilds()).toHaveLength(1);
        expect(dockerRun()!.args).toContain('API_KEY=new-value');
    });
});

describe('restart (compose)', () => {
    beforeEach(() => { project = composeProject(); });

    it('brings the stack up without --build and keeps the local images on the way down', async () => {
        await ProcessService.restart(PROJECT_ID);

        const ups = composeUps();
        expect(ups).toHaveLength(1);
        expect(ups[0]).not.toContain('--build');
        // Stale blue-green generations may still be swept with their images;
        // the active stack's own images must survive the stop.
        const baseDowns = dockerCalls().filter(c => c.includes(`-p ${CONTAINER} `) && c.includes(' down'));
        expect(baseDowns.length).toBeGreaterThan(0);
        expect(baseDowns.filter(c => c.includes('--rmi'))).toHaveLength(0);
    });

    it('rewrites .runnable.env with the current env vars', async () => {
        await ProcessService.restart(PROJECT_ID);
        const env = await fs.readFile(path.join(dir, '.runnable.env'), 'utf-8');
        expect(env).toContain('API_KEY=new-value');
    });
});

describe('rebuild (compose)', () => {
    beforeEach(() => { project = composeProject(); });

    it('brings the stack up with --build', async () => {
        await ProcessService.rebuild(PROJECT_ID);

        const ups = composeUps();
        expect(ups).toHaveLength(1);
        expect(ups[0]).toContain('--build');
    });
});

describe('restartIfStillError', () => {
    it('does not rebuild a crashed container when its image still exists', async () => {
        project.status = 'error';
        const ran = await ProcessService.restartIfStillError(PROJECT_ID);

        expect(ran).toBe(true);
        expect(railpackBuilds()).toHaveLength(0);
        expect(dockerRun()).toBeDefined();
    });
});
