import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    UpdateDateColumn,
    OneToMany,
} from 'typeorm';
import { Role } from './enums';
import { Project } from './Project';
import { ProjectCollaborator } from './ProjectCollaborator';

export interface UserPermissions {
    maxProjects: number | null;
    canCreateProjects: boolean;
    canUseCustomDomains: boolean;
    allowedServerTypes: string[] | null;
}

export const DEFAULT_USER_PERMISSIONS: UserPermissions = {
    maxProjects: null,
    canCreateProjects: true,
    canUseCustomDomains: true,
    allowedServerTypes: null,
};

@Entity('users')
export class User {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ unique: true })
    email: string;

    @Column({ unique: true })
    username: string;

    @Column({ nullable: true })
    passwordHash?: string;

    @Column({ type: 'enum', enum: Role, default: Role.USER })
    role: Role;

    @Column({ default: false })
    isApproved: boolean;

    @Column({ nullable: true, unique: true })
    githubId?: string;

    @Column({ nullable: true, unique: true })
    googleId?: string;

    @Column({ nullable: true })
    githubToken?: string;

    @Column({ type: 'simple-json', nullable: true })
    permissions?: UserPermissions;

    @OneToMany(() => Project, (project) => project.user)
    projects: Project[];

    @OneToMany(() => ProjectCollaborator, (collab) => collab.user)
    collaborations: ProjectCollaborator[];

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
