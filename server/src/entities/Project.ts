import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    UpdateDateColumn,
    ManyToOne,
    OneToOne,
    OneToMany,
} from 'typeorm';
import { ServerType, ServiceStatus } from './enums';
import { User } from './User';
import { GithubRepo } from './GithubRepo';
import { CustomDomain } from './CustomDomain';

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

    @ManyToOne(() => User, (user) => user.projects, { onDelete: 'CASCADE' })
    user: User;

    @Column()
    userId: string;

    @OneToOne(() => GithubRepo, (repo) => repo.project, { nullable: true, cascade: true })
    githubRepo?: GithubRepo;

    @OneToMany(() => CustomDomain, (domain) => domain.project, { cascade: true })
    customDomains: CustomDomain[];

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
