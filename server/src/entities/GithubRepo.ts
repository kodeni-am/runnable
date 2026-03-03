import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    OneToOne,
    JoinColumn,
} from 'typeorm';
import { Project } from './Project';

@Entity('github_repos')
export class GithubRepo {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'varchar' })
    repoUrl: string;

    @Column({ default: 'main' })
    branch: string;

    @Column({ default: false })
    isPrivate: boolean;

    @Column({ nullable: true })
    webhookId?: string;

    @Column({ nullable: true })
    webhookSecret?: string;

    @Column({ type: 'timestamp', nullable: true })
    lastDeployAt?: Date;

    @OneToOne(() => Project, (project) => project.githubRepo, { onDelete: 'CASCADE' })
    @JoinColumn()
    project: Project;

    @Column()
    projectId: string;
}
