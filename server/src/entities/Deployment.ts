import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    ManyToOne,
    JoinColumn,
    Index,
} from 'typeorm';
import { Project } from './Project';

export type DeploymentStatus = 'success' | 'failed';
export type DeploymentTrigger = 'webhook' | 'rollback';
export type DeployStrategyValue = 'blue-green' | 'compose-inplace' | 'recreate';
export type HealthGateValue = 'passed' | 'degraded';

@Entity('deployments')
export class Deployment {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @ManyToOne(() => Project, { onDelete: 'CASCADE' })
    @JoinColumn()
    project: Project;

    @Index()
    @Column()
    projectId: string;

    @Column({ nullable: true })
    commitSha?: string;

    @Column({ type: 'text', nullable: true })
    commitMessage?: string;

    @Column({ default: 'main' })
    branch: string;

    @Column({ type: 'varchar' })
    status: DeploymentStatus;

    @Column({ type: 'varchar' })
    trigger: DeploymentTrigger;

    @Column({ type: 'text', nullable: true })
    error?: string;

    /** How the deploy ran. Null for rows predating zero-downtime deploys. */
    @Column({ type: 'varchar', nullable: true })
    strategy?: DeployStrategyValue;

    /** For failed rows: did the previous version keep serving? */
    @Column({ type: 'boolean', nullable: true })
    stillServing?: boolean;

    @Column({ type: 'integer', nullable: true })
    durationMs?: number;

    @Column({ type: 'varchar', nullable: true })
    healthGate?: HealthGateValue;

    /** Tier-3 fallback reason, e.g. "service db mounts named volume pgdata" */
    @Column({ type: 'text', nullable: true })
    strategyReason?: string;

    @CreateDateColumn()
    createdAt: Date;
}
