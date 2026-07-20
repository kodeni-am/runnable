import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { ServerConfigService } from '../serverConfig.service';
import { FileManagerService } from '../fileManager.service';
import { ServerType } from '../../entities';

describe('static site dotfile protection', () => {
    it('blocks dotfile requests for static sites', async () => {
        const out = await ServerConfigService.generateConfig({
            subdomain: 'site',
            directoryPath: '/srv/site',
            port: 0,
            serverType: ServerType.STATIC,
        });
        expect(out).toContain('@dot path /.*');
        expect(out).toContain('respond @dot 403');
    });
});

describe('file browser dotfile guard', () => {
    let dir: string;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dotfile-test-'));
        await fs.writeFile(path.join(dir, '.npmrc'), 'secret=1\n');
        await fs.writeFile(path.join(dir, 'index.html'), '<h1>hi</h1>');
    });

    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('refuses to read a dotfile', async () => {
        await expect(FileManagerService.readFile(dir, '.npmrc'))
            .rejects.toMatchObject({ statusCode: 403 });
    });

    it('refuses to read a dotfile in a subdirectory', async () => {
        await fs.mkdir(path.join(dir, 'sub'));
        await fs.writeFile(path.join(dir, 'sub', '.env'), 'X=1');
        await expect(FileManagerService.readFile(dir, 'sub/.env'))
            .rejects.toMatchObject({ statusCode: 403 });
    });

    it('refuses to write a dotfile', async () => {
        await expect(FileManagerService.writeFile(dir, '.npmrc', 'hacked'))
            .rejects.toMatchObject({ statusCode: 403 });
    });

    it('refuses to delete a dotfile', async () => {
        await expect(FileManagerService.deleteFile(dir, '.npmrc'))
            .rejects.toMatchObject({ statusCode: 403 });
    });

    it('still allows normal files', async () => {
        const { content } = await FileManagerService.readFile(dir, 'index.html');
        expect(content).toBe('<h1>hi</h1>');
        await FileManagerService.writeFile(dir, 'page.html', 'ok');
        expect(await fs.readFile(path.join(dir, 'page.html'), 'utf-8')).toBe('ok');
    });

    it('still allows listing the directory root', async () => {
        const files = await FileManagerService.listFiles(dir, '');
        expect(files.map(f => f.name)).toContain('index.html');
        expect(files.map(f => f.name)).not.toContain('.npmrc');
    });
});
