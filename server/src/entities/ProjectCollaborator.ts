import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    ManyToOne,
    Unique,
} from 'typeorm';
import { User } from './User';
import { Project } from './Project';

export interface ProjectPermissions {
    canStart: boolean;
    canEditConfig: boolean;
    canEditDomains: boolean;
    canEditFiles: boolean;
    canDelete: boolean;
    canViewLogs: boolean;
    canViewFiles: boolean;
    canViewDomains: boolean;
    canViewGithub: boolean;
    canViewSettings: boolean;
}

export const DEFAULT_PROJECT_PERMISSIONS: ProjectPermissions = {
    canStart: false,
    canEditConfig: false,
    canEditDomains: false,
    canEditFiles: false,
    canDelete: false,
    canViewLogs: true,
    canViewFiles: true,
    canViewDomains: true,
    canViewGithub: true,
    canViewSettings: true,
};

@Entity('project_collaborators')
@Unique(['userId', 'projectId'])
export class ProjectCollaborator {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    userId: string;

    @Column()
    projectId: string;

    @Column({ type: 'simple-json' })
    permissions: ProjectPermissions;

    @ManyToOne(() => User, (user) => user.collaborations, { onDelete: 'CASCADE' })
    user: User;

    @ManyToOne(() => Project, (project) => project.collaborators, { onDelete: 'CASCADE' })
    project: Project;

    @CreateDateColumn()
    createdAt: Date;
}
