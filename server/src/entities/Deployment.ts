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

    @CreateDateColumn()
    createdAt: Date;
}
