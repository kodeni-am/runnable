import { Project } from '../entities';

export interface NotificationEvent {
    /** Machine-readable key, e.g. 'deploy.success', 'health.down' */
    event: string;
    title: string;
    message: string;
    success: boolean;
    /** Extra context (commit, branch, error, ...) — undefined values are dropped */
    meta?: Record<string, string | undefined>;
}

const DISCORD_GREEN = 0x46a758;
const DISCORD_RED = 0xe5484d;

export class NotificationService {
    /**
     * POST a notification to the project's webhook URL, shaping the payload
     * for Discord/Slack when recognized. Never throws — a broken webhook must
     * not fail the deploy that triggered it.
     */
    static async notify(project: Project, event: NotificationEvent): Promise<void> {
        const url = project.notificationWebhookUrl;
        if (!url) return;

        let parsed: URL;
        try {
            parsed = new URL(url);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
        } catch {
            return;
        }

        const meta = Object.fromEntries(
            Object.entries(event.meta || {}).filter(([, v]) => v !== undefined)
        ) as Record<string, string>;

        let body: unknown;
        const host = parsed.hostname;
        if (host === 'discord.com' || host === 'discordapp.com') {
            const fields = Object.entries(meta).map(([name, value]) => ({
                name,
                value: value.slice(0, 1024),
                inline: true,
            }));
            body = {
                embeds: [{
                    title: event.title.slice(0, 256),
                    description: event.message.slice(0, 4096),
                    color: event.success ? DISCORD_GREEN : DISCORD_RED,
                    fields,
                }],
            };
        } else if (host === 'hooks.slack.com') {
            const metaLines = Object.entries(meta).map(([k, v]) => `• ${k}: ${v}`).join('\n');
            body = {
                text: `${event.success ? ':white_check_mark:' : ':x:'} *${event.title}*\n${event.message}${metaLines ? `\n${metaLines}` : ''}`,
            };
        } else {
            body = {
                event: event.event,
                success: event.success,
                title: event.title,
                message: event.message,
                project: { id: project.id, name: project.name, subdomain: project.subdomain },
                meta,
                timestamp: new Date().toISOString(),
            };
        }

        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10_000);
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            clearTimeout(timeout);
            if (!res.ok) {
                console.warn(`Notification webhook for project ${project.id} returned ${res.status}`);
            }
        } catch (err: any) {
            console.warn(`Notification webhook for project ${project.id} failed:`, err?.message);
        }
    }
}
