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

/**
 * Coerce untrusted input into a well-formed permissions object: unknown keys
 * are dropped, wrong-typed values fall back to the defaults. These values
 * drive enforcement in the project routes, so arbitrary JSON must never be
 * persisted.
 */
export function sanitizeUserPermissions(input: unknown): UserPermissions {
    const perms = { ...DEFAULT_USER_PERMISSIONS };
    if (input && typeof input === 'object') {
        const i = input as Record<string, unknown>;
        if (i.maxProjects === null || (typeof i.maxProjects === 'number' && Number.isInteger(i.maxProjects) && i.maxProjects >= 0)) {
            perms.maxProjects = i.maxProjects as number | null;
        }
        if (typeof i.canCreateProjects === 'boolean') perms.canCreateProjects = i.canCreateProjects;
        if (typeof i.canUseCustomDomains === 'boolean') perms.canUseCustomDomains = i.canUseCustomDomains;
        if (i.allowedServerTypes === null) {
            perms.allowedServerTypes = null;
        } else if (Array.isArray(i.allowedServerTypes)) {
            perms.allowedServerTypes = i.allowedServerTypes.filter((s): s is string => typeof s === 'string');
        }
    }
    return perms;
}

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

    /**
     * Bumped on password/email change to invalidate all previously issued
     * tokens — stateless JWTs can't be revoked any other way.
     */
    @Column({ default: 0 })
    tokenVersion: number;

    @OneToMany(() => Project, (project) => project.user)
    projects: Project[];

    @OneToMany(() => ProjectCollaborator, (collab) => collab.user)
    collaborations: ProjectCollaborator[];

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
