import fs from 'fs/promises';
import path from 'path';
import { AppDataSource } from '../config/data-source';
import { Project } from '../entities';
import { ProcessService } from './process.service';
import { SandboxService } from './sandbox.service';
import { ServerConfigService } from './serverConfig.service';
import { GithubService } from './github.service';
import { config } from '../config';

/**
 * Tears down ALL runtime + persistent resources for a project and deletes its
 * row. Used by DELETE /projects/:id and (in a later phase) preview teardown.
 *
 * `removeWebhookToken` is the GitHub token to use when removing the project's
 * webhook (the acting user's token). Preview rows have no webhook, so callers
 * tearing down a preview pass undefined.
 */
export class ProjectTeardownService {
    static async teardown(project: Project, removeWebhookToken?: string): Promise<void> {
        // Stop container/compose stack and remove the built image. Unconditional
        // so leftover containers in ERROR/BUILDING states are also cleaned up.
        await ProcessService.destroy(project.id);

        // Remove the GitHub webhook so it stops firing at our API.
        if (project.githubRepo?.webhookId && removeWebhookToken) {
            await GithubService.removeWebhook(
                project.githubRepo.repoUrl,
                removeWebhookToken,
                project.githubRepo.webhookId,
            ).catch(() => { });
        }

        // Remove reverse-proxy config
        if (project.configPath) {
            await ServerConfigService.removeConfig(project.configPath);
        }

        // Destroy sandbox user
        await SandboxService.destroySandbox(project.id);

        // Remove project directory (cloned repo, build artifacts, .runnable.env)
        if (project.directoryPath) {
            await fs.rm(project.directoryPath, { recursive: true, force: true }).catch(() => { });
        }

        // Remove log files (build log + reverse-proxy access/error logs).
        const storageDir = path.resolve(config.hosting.servDir, '..');
        const logFiles = [
            path.join(storageDir, 'logs', `${project.subdomain}-build.log`),
            path.join(storageDir, 'logs', `${project.subdomain}-access.log`),
            path.join(storageDir, 'logs', `${project.subdomain}-error.log`),
            path.resolve('./storage/logs', `${project.subdomain}-build.log`),
            path.resolve('./storage/logs', `${project.subdomain}-access.log`),
            path.resolve('./storage/logs', `${project.subdomain}-error.log`),
            `/var/log/caddy/${project.subdomain}.log`,
        ];
        await Promise.all(logFiles.map(f => fs.rm(f, { force: true }).catch(() => { })));

        await AppDataSource.getRepository(Project).remove(project);
    }
}
