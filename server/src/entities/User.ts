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

    @OneToMany(() => Project, (project) => project.user)
    projects: Project[];

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
