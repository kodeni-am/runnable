import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    UpdateDateColumn,
    ManyToOne,
    OneToOne,
    OneToMany,
    JoinColumn,
} from 'typeorm';
import { ServerType, ServiceStatus } from './enums';
import { User } from './User';
import { GithubRepo } from './GithubRepo';
import { CustomDomain } from './CustomDomain';
import { ProjectCollaborator } from './ProjectCollaborator';

@Entity('projects')
export class Project {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    name: string;

    @Column({ unique: true })
    subdomain: string;

    @Column()
    directoryPath: string;

    @Column({ type: 'enum', enum: ServerType })
    serverType: ServerType;

    @Column({ type: 'enum', enum: ServiceStatus, default: ServiceStatus.STOPPED })
    status: ServiceStatus;

    @Column({ nullable: true })
    port?: number;

    @Column({ nullable: true })
    configPath?: string;

    @Column({ nullable: true })
    containerId?: string;

    @Column({ nullable: true })
    internalPort?: number;

    @Column({ nullable: true })
    buildCommand?: string;

    @Column({ nullable: true })
    startCommand?: string;

    @Column({ type: 'simple-json', nullable: true })
    envVars?: Record<string, string>;

    /** True when this APP project should be managed with docker compose */
    @Column({ default: false })
    useCompose: boolean;

    /**
     * Path to the compose file relative to `directoryPath`.
     * Defaults to `docker-compose.yml` when `useCompose` is true.
     */
    @Column({ nullable: true })
    composeFile?: string;

    /**
     * The compose service whose published port Runnable will proxy.
     * Required when `useCompose` is true.
     */
    @Column({ nullable: true })
    composeService?: string;

    /**
     * Optional webhook URL notified on deploy success/failure, rollbacks, and
     * health events. Discord and Slack webhook URLs get their native payload
     * shape; anything else receives a generic JSON event.
     */
    @Column({ nullable: true })
    notificationWebhookUrl?: string;

    /** Restart the container automatically when the health monitor finds it dead */
    @Column({ default: false })
    autoRestart: boolean;

    /** Blue-green deploys: keep the old container serving while the new one builds */
    @Column({ default: true })
    zeroDowntime: boolean;

    // ── Preview / PR deployments ──────────────────────────────────────────────

    /** Parent-project config: enable ephemeral per-PR preview environments */
    @Column({ default: false })
    previewsEnabled: boolean;

    /** Base domain previews are served under, e.g. "preview.example.com" */
    @Column({ nullable: true })
    previewBaseDomain?: string;

    /** Env vars that override inherited parent env when building a preview */
    @Column({ type: 'simple-json', nullable: true })
    previewEnvOverrides?: Record<string, string>;

    /** Tear a preview down after this many days with no new commits */
    @Column({ default: 7 })
    previewTtlDays: number;

    /** True when this row IS a preview environment (not a normal project) */
    @Column({ default: false })
    isPreview: boolean;

    /** For a preview row: the parent project it belongs to */
    @ManyToOne(() => Project, { nullable: true, onDelete: 'CASCADE' })
    @JoinColumn({ name: 'parentProjectId' })
    parentProject?: Project;

    @Column({ nullable: true })
    parentProjectId?: string;

    /** For a preview row: the GitHub PR number */
    @Column({ nullable: true })
    prNumber?: number;

    /** For a preview row: the PR head branch */
    @Column({ nullable: true })
    prBranch?: string;

    /** For a preview row: last deploy time, used by the TTL sweep */
    @Column({ type: 'timestamp', nullable: true })
    lastActivityAt?: Date;

    /**
     * Overrides config.hosting.baseDomain when generating this project's Caddy
     * config. Preview rows set this to the parent's previewBaseDomain; normal
     * projects leave it null.
     */
    @Column({ nullable: true })
    baseDomain?: string;

    @ManyToOne(() => User, (user) => user.projects, { onDelete: 'CASCADE' })
    user: User;

    @Column()
    userId: string;

    @OneToOne(() => GithubRepo, (repo) => repo.project, { nullable: true, cascade: true })
    githubRepo?: GithubRepo;

    @OneToMany(() => CustomDomain, (domain) => domain.project, { cascade: true })
    customDomains: CustomDomain[];

    @OneToMany(() => ProjectCollaborator, (collab) => collab.project, { cascade: true })
    collaborators: ProjectCollaborator[];

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
